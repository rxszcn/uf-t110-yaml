import type { Alias } from 'yaml'
import {
  parse,
  parseAllDocuments,
  parseDocument,
  visit,
  YAMLParseError
} from 'yaml'

/**
 * Self-referential aliases, i.e. aliases whose resolved anchor is one of the
 * alias node's own ancestors. Such documents are valid YAML, and by default
 * the composer keeps them without any error or warning; the `detectAliasCycles`
 * parse option makes it report an `ALIAS_CYCLE` error for each such alias.
 */

/** Wrap `core` in `depth` alternating block map / block sequence levels. */
function nest(core: string, depth: number): string {
  const indented = (s: string) => s.replace(/\n/g, '\n  ')
  let src = core
  for (let i = 0; i < depth; ++i) {
    src = i % 2 === 0 ? `p:\n  ${indented(src)}` : `- ${indented(src)}`
  }
  return `${src}\n`
}

/**
 * Self-referential alias forms, named after the contained collection style.
 * `value` forms appear as map values or sequence items, so their JS
 * representation is cyclic; `key` forms get stringified as map keys, so only
 * the node graph contains the cycle.
 */
const CYCLE_FORMS = {
  'flow map value': { core: '&a { self: *a }', jsCyclic: true },
  'flow sequence item': { core: '&a [ *a ]', jsCyclic: true },
  'flow map key': { core: '&a { ? *a : v }', jsCyclic: false },
  'block map value': { core: '&a\nself: *a', jsCyclic: true },
  'block sequence item': { core: '&a\n- *a', jsCyclic: true },
  'block map key': { core: '&a\n? *a\n: v', jsCyclic: false },
  'tagged flow map': { core: '&a !!map { self: *a }', jsCyclic: true },
  'indirect ancestor': { core: '&a { child: &b { self: *a } }', jsCyclic: true }
}

const DEPTHS = [0, 1, 2, 3]

describe('self-referential alias detection', () => {
  describe('disabled by default', () => {
    for (const [form, { core, jsCyclic }] of Object.entries(CYCLE_FORMS)) {
      for (const depth of DEPTHS) {
        const src = nest(core, depth)
        test(`${form} at depth ${depth}`, () => {
          const doc = parseDocument(src)
          expect(doc.errors).toHaveLength(0)
          expect(doc.warnings).toHaveLength(0)
          expect(doc.options.detectAliasCycles).toBe(false)
          // The node representation keeps the alias as a leaf, so the
          // document round-trips, retaining the alias node.
          expect(String(doc)).toContain('*a')
          if (jsCyclic) {
            const js = doc.toJS()
            expect(() => JSON.stringify(js)).toThrow(/circular structure/)
          }
        })
      }
    }

    test('default and explicit false are identical', () => {
      for (const { core } of Object.values(CYCLE_FORMS)) {
        for (const depth of DEPTHS) {
          const src = nest(core, depth)
          const impl = parseDocument(src)
          const expl = parseDocument(src, { detectAliasCycles: false })
          expect(expl.errors).toEqual([])
          expect(expl.warnings).toEqual([])
          expect(String(expl)).toBe(String(impl))
        }
      }
    })

    test('toJS() of a self-referential mapping is cyclic', () => {
      const doc = parseDocument('&a { self: *a }')
      const obj = doc.toJS()
      expect(obj.self).toBe(obj)
    })

    test('toJS() of a self-referential sequence is cyclic', () => {
      const doc = parseDocument('&a [ 1, *a ]')
      const seq = doc.toJS()
      expect(seq[1]).toBe(seq)
    })
  })

  describe('enabled', () => {
    for (const [form, { core }] of Object.entries(CYCLE_FORMS)) {
      for (const depth of DEPTHS) {
        const src = nest(core, depth)
        const aliasOffset = src.lastIndexOf('*a')
        test(`${form} at depth ${depth}`, () => {
          const doc = parseDocument(src, {
            detectAliasCycles: true,
            prettyErrors: false
          })
          expect(doc.errors).toMatchObject([
            {
              name: 'YAMLParseError',
              code: 'ALIAS_CYCLE',
              pos: [aliasOffset, aliasOffset + 2],
              message: 'Self-referential alias: &a is an ancestor of *a'
            }
          ])
          expect(doc.warnings).toHaveLength(0)
        })
      }
    }

    test('only the closing aliases are reported', () => {
      const doc = parseDocument('&a [ *a, *a ]', {
        detectAliasCycles: true,
        prettyErrors: false
      })
      expect(doc.errors.map(error => error.code)).toEqual([
        'ALIAS_CYCLE',
        'ALIAS_CYCLE'
      ])
      expect(doc.errors.map(error => error.pos)).toEqual([
        [5, 7],
        [9, 11]
      ])
    })

    test('an alias that resolves to its immediate parent is reported', () => {
      const doc = parseDocument('&a { b: &b { self: *b } }', {
        detectAliasCycles: true,
        prettyErrors: false
      })
      // *b resolves to &b, which is the directly enclosing map; *a is not
      // used here at all, so only the inner alias closes a cycle.
      expect(doc.errors.map(error => [error.code, error.pos])).toEqual([
        ['ALIAS_CYCLE', [19, 21]]
      ])
    })

    test('three-level cycle reports the alias that closes it', () => {
      const doc = parseDocument('&a { b: &b { c: &c { d: *a } } }', {
        detectAliasCycles: true,
        prettyErrors: false
      })
      expect(doc.errors).toMatchObject([{ code: 'ALIAS_CYCLE', pos: [24, 26] }])
    })

    test('merge alias closing a cycle is reported', () => {
      const doc = parseDocument('&a { <<: *a, b: B }', {
        detectAliasCycles: true,
        merge: true,
        prettyErrors: false
      })
      expect(doc.errors).toMatchObject([{ code: 'ALIAS_CYCLE', pos: [9, 11] }])
    })

    test('set item closing a cycle is reported', () => {
      const doc = parseDocument('&a !!set { *a }', {
        detectAliasCycles: true,
        prettyErrors: false
      })
      expect(doc.errors).toMatchObject([{ code: 'ALIAS_CYCLE', pos: [11, 13] }])
    })

    test('parse() throws a YAMLParseError with the anchor name and position', () => {
      expect.assertions(5)
      try {
        parse('&net { self: *net }', { detectAliasCycles: true })
      } catch (error) {
        expect(error).toBeInstanceOf(YAMLParseError)
        const err = error as YAMLParseError
        expect(err.code).toBe('ALIAS_CYCLE')
        expect(err.pos).toEqual([13, 17])
        expect(err.linePos).toEqual([
          { line: 1, col: 14 },
          { line: 1, col: 18 }
        ])
        expect(err.message).toMatch(
          /^Self-referential alias: &net is an ancestor of \*net at line 1, column 14:/
        )
      }
    })

    test('a document with detected cycles cannot be stringified', () => {
      const doc = parseDocument('&a { self: *a }', {
        detectAliasCycles: true
      })
      expect(() => String(doc)).toThrow(
        'Document with errors cannot be stringified'
      )
    })

    test('each document of a stream is checked separately', () => {
      const docs = parseAllDocuments(
        '&a [ *a ]\n---\nb: 1\n---\n&c { self: *c }\n',
        { detectAliasCycles: true, prettyErrors: false }
      )
      expect(docs.map(doc => doc.errors.map(error => error.code))).toEqual([
        ['ALIAS_CYCLE'],
        [],
        ['ALIAS_CYCLE']
      ])
    })

    test('deeply nested documents are checked without a stack overflow', () => {
      const depth = 200
      const src = nest('&a { self: *a }', depth)
      const doc = parseDocument(src, {
        detectAliasCycles: true,
        prettyErrors: false
      })
      expect(doc.errors).toMatchObject([{ code: 'ALIAS_CYCLE' }])
    })

    test('detection does not change the parsed node tree', () => {
      const src = '&a { self: *a, other: *a }'
      const plain = parseDocument(src)
      const checked = parseDocument(src, { detectAliasCycles: true })
      const aliases = (doc: ReturnType<typeof parseDocument>) => {
        const res: string[] = []
        visit(doc.value, {
          Alias(_key, node: Alias) {
            res.push(node.source)
          }
        })
        return res
      }
      expect(aliases(checked)).toEqual(aliases(plain))
      expect(aliases(checked)).toEqual(['a', 'a'])
    })
  })

  describe('aliases that are not cycles', () => {
    const ok: Array<[string, string]> = [
      ['sibling reference', 'a: &a 1\nb: *a\n'],
      ['nested sibling reference', 'a: &a 1\nb:\n  c:\n    - *a\n'],
      ['sequence of anchors', '- &a 1\n- *a\n'],
      ['re-defined anchor shadowing', '&a { inner: &a 1, self: *a }\n'],
      [
        're-defined collection anchor shadowing',
        '&a { inner: &a [ 1 ], self: *a }\n'
      ],
      ['forward reference to a later anchor', 'a: *x\nb: &x 1\n'],
      ['undefined alias', 'a: *missing\n']
    ]

    for (const [name, src] of ok) {
      test(name, () => {
        const doc = parseDocument(src, {
          detectAliasCycles: true,
          prettyErrors: false
        })
        expect(doc.errors).toHaveLength(0)
        expect(doc.warnings).toHaveLength(0)
      })
    }
  })

  describe('undefined alias contract is unchanged', () => {
    const msg = (name: string) =>
      `Unresolved alias (the anchor must be set before the alias): ${name}`

    test('parseDocument reports no error at load time', () => {
      const doc = parseDocument('a: *missing\n', { detectAliasCycles: true })
      expect(doc.errors).toHaveLength(0)
    })

    test('toJS() throws the existing ReferenceError message', () => {
      const doc = parseDocument('a: *missing\n')
      expect(() => doc.toJS()).toThrow(ReferenceError)
      expect(() => doc.toJS()).toThrow(msg('missing'))
    })

    test('toString() throws the existing Error message', () => {
      const doc = parseDocument('a: *x\nb: &x 1\n')
      expect(() => String(doc)).toThrow(msg('x'))
    })

    test('merge with an undefined alias throws the existing message', () => {
      expect(() => parse('{ <<: *undef }', { merge: true })).toThrow(
        msg('undef')
      )
    })
  })
})
