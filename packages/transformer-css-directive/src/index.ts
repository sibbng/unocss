import { expandVariantGroup, notNull } from '@unocss/core'
import type { SourceCodeTransformer, StringifiedUtil, UnoGenerator } from '@unocss/core'
import type { CssNode, ListItem, Selector, SelectorList, StyleSheet } from 'css-tree'
import { List, clone, generate, parse, walk } from 'css-tree'

type Writeable<T> = { -readonly [P in keyof T]: T[P] }

export default function transformerCSSDirective(): SourceCodeTransformer {
  return {
    name: 'css-directive',
    enforce: 'pre',
    idFilter: id => id.endsWith('.css'),
    transform: (code, id, ctx) => {
      return transformCSSDirective(code, ctx.uno, id)
    },
  }
}

export async function transformCSSDirective(css: string, uno: UnoGenerator, filename?: string) {
  if (!css.includes('@apply'))
    return css

  const ast = parse(css, {
    parseAtrulePrelude: false,
    positions: true,
    filename,
  })

  if (ast.type !== 'StyleSheet')
    return css

  const stack: Promise<void>[] = []

  const processNode = async(node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) => {
    if (node.type !== 'Rule')
      return

    await Promise.all(
      node.block.children.map(async(childNode, childItem) => {
        if (!(childNode.type === 'Atrule' && childNode.name === 'apply' && childNode.prelude))
          return

        if (childNode.prelude.type !== 'Raw')
          return

        const classNames = expandVariantGroup(childNode.prelude.value).split(/\s+/g)

        const utils = (
          await Promise.all(
            classNames.map(i => uno.parseToken(i, '-')),
          ))
          .filter(notNull).flat()
          .sort((a, b) => a[0] - b[0])
          .reduce((acc, item) => {
            const target = acc.find(i => i[1] === item[1] && i[3] === item[3])
            if (target)
              target[2] += item[2]
            else
              // use spread operator to prevent reassign to uno internal cache
              acc.push([...item] as Writeable<StringifiedUtil>)
            return acc
          }, [] as Writeable<StringifiedUtil>[])

        if (!utils.length)
          return

        const parentSelector = generate(node.prelude)

        for (const i of utils) {
          const [, selector, body, parent] = i
          if (parent) {
            const newNodeCss = `${parent}{${parentSelector}{${body}}}`
            const insertNodeAst = parse(newNodeCss) as StyleSheet

            list.insertList(insertNodeAst.children, item)
          }
          else if (selector && selector !== '.\\-') {
            const pseudoClassSelectors = (
              parse(selector, {
                context: 'selector',
              }) as Selector)
              .children
              .filter(i => i.type === 'PseudoClassSelector')

            const parentSelectorAst = clone(node.prelude) as SelectorList

            parentSelectorAst.children.forEach((i) => {
              if (i.type === 'Selector')
                i.children.appendList(pseudoClassSelectors.copy())
            })

            const newNodeCss = `${generate(parentSelectorAst)}{${body}}`
            const insertNodeAst = parse(newNodeCss) as StyleSheet

            list.insertList(insertNodeAst.children, item)
          }
          else {
            const rules = new List<string>()
              .fromArray(body
                .replace(/;$/, '')
                .split(';'),
              ).map(i => parse(i, {
                context: 'declaration',
              }))

            node.block.children.insertList(rules, childItem)
          }
        }
        node.block.children.remove(childItem)
      }).toArray(),
    )
  }

  walk(ast, (...args) => stack.push(processNode(...args)))

  await Promise.all(stack)

  return generate(ast)
}