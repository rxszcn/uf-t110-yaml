import type { DocValue } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import type { Node } from '../nodes/types.ts'
import { Pair } from '../nodes/Pair.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { ComposeErrorHandler } from './composer.ts'

/**
 * Report an error for every alias whose resolved anchor is an ancestor of the
 * alias node, i.e. for every alias that closes a cycle in the document graph.
 *
 * A composed document is a tree of nodes in which `Alias` is a leaf, so an
 * alias may point at a node that (transitively) contains the alias itself.
 * Such a document is valid YAML, and the node representation keeps it
 * faithfully, but `toJS()` produces a cyclic value that cannot be serialised
 * as JSON, and `toString()` writes it back only because the alias node itself
 * is retained.
 *
 * Every alias resolves to a node that starts before the alias in the document,
 * so a cycle always includes at least one alias that resolves to one of its
 * own ancestors. Walking the tree in document order with the same "most recent
 * preceding anchor" rule as `Alias#resolve()` therefore finds every cycle, and
 * correctly ignores an alias that refers to a later re-definition of the same
 * anchor name.
 */
export function checkAliasCycles(
  value: DocValue,
  onError: ComposeErrorHandler
): void {
  /** Most recent anchor for each name, in document order. */
  const anchors = new Map<string, Node>()
  /** Nodes on the current ancestor path. */
  const ancestry = new Set<Node>()

  type Frame = Node | Pair | { exit: Node }
  const isExit = (frame: Frame): frame is { exit: Node } =>
    typeof frame === 'object' && 'exit' in frame

  const pushChildren = (stack: Frame[], item: Node): void => {
    if (item instanceof YAMLSeq) {
      for (let i = item.length - 1; i >= 0; --i) stack.push(item[i])
    } else if (item instanceof YAMLMap) {
      const pairs = Array.from(item.values.values())
      for (let i = pairs.length - 1; i >= 0; --i) stack.push(pairs[i])
    } else if (item instanceof YAMLSet) {
      const nodes = Array.from(item.values.values())
      for (let i = nodes.length - 1; i >= 0; --i) stack.push(nodes[i])
    }
  }

  // Iterative depth-first walk, so that deeply nested documents cannot
  // overflow the call stack here.
  const stack: Frame[] = [value]
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (isExit(frame)) {
      ancestry.delete(frame.exit)
      continue
    }

    if (frame instanceof Alias) {
      const anchor = anchors.get(frame.source)
      if (anchor && ancestry.has(anchor)) {
        const name = frame.source
        const msg = `Self-referential alias: &${name} is an ancestor of *${name}`
        onError(frame.range ?? frame.srcToken ?? 0, 'ALIAS_CYCLE', msg)
      }
      continue
    }

    if (frame instanceof Pair) {
      if (frame.value) stack.push(frame.value)
      stack.push(frame.key)
      continue
    }

    const anchor = frame.anchor
    if (anchor) anchors.set(anchor, frame)
    ancestry.add(frame)
    stack.push({ exit: frame })
    pushChildren(stack, frame)
  }
}
