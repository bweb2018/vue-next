import {
  RootNode,
  NodeTypes,
  ParentNode,
  ChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode
} from './ast'
import { isString, isArray } from '@vue/shared'
import { CompilerError, defaultOnError } from './errors'
import { TO_STRING, COMMENT, CREATE_VNODE } from './runtimeConstants'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: ChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  context: TransformContext
) => {
  props: Property | Property[]
  needRuntime: boolean
}

// A structural directive transform is a techically a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface TransformOptions {
  nodeTransforms?: NodeTransform[]
  directiveTransforms?: { [name: string]: DirectiveTransform }
  prefixIdentifiers?: boolean
  onError?: (error: CompilerError) => void
}

export interface TransformContext extends Required<TransformOptions> {
  root: RootNode
  imports: Set<string>
  statements: Set<string>
  hoists: JSChildNode[]
  identifiers: { [name: string]: number | undefined }
  parent: ParentNode
  childIndex: number
  currentNode: ChildNode | null
  helper(name: string): string
  replaceNode(node: ChildNode): void
  removeNode(node?: ChildNode): void
  onNodeRemoved: () => void
  addIdentifiers(exp: ExpressionNode): void
  removeIdentifiers(exp: ExpressionNode): void
  hoist(exp: JSChildNode): ExpressionNode
}

function createTransformContext(
  root: RootNode,
  {
    prefixIdentifiers = false,
    nodeTransforms = [],
    directiveTransforms = {},
    onError = defaultOnError
  }: TransformOptions
): TransformContext {
  const context: TransformContext = {
    root,
    imports: new Set(),
    statements: new Set(),
    hoists: [],
    identifiers: {},
    prefixIdentifiers,
    nodeTransforms,
    directiveTransforms,
    onError,
    parent: root,
    childIndex: 0,
    currentNode: null,
    helper(name) {
      context.imports.add(name)
      return prefixIdentifiers ? name : `_${name}`
    },
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__ && !context.currentNode) {
        throw new Error(`node being replaced is already removed.`)
      }
      context.parent.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      const list = context.parent.children
      const removalIndex = node
        ? list.indexOf(node as any)
        : context.currentNode
          ? context.childIndex
          : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    hoist(exp) {
      context.hoists.push(exp)
      return createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc
      )
    }
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    ;(identifiers[id] as number)++
  }

  function removeId(id: string) {
    ;(context.identifiers[id] as number)--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions) {
  const context = createTransformContext(root, options)
  traverseChildren(root, context)
  root.imports = [...context.imports]
  root.statements = [...context.statements]
  root.hoists = context.hoists
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue
    context.currentNode = child
    context.parent = parent
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

export function traverseNode(node: ChildNode, context: TransformContext) {
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  for (let i = 0; i < nodeTransforms.length; i++) {
    const plugin = nodeTransforms[i]
    const onExit = plugin(node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    if (!context.currentNode) {
      // node was removed
      return
    } else {
      // node may have been replaced
      node = context.currentNode
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      context.helper(CREATE_VNODE)
      // inject import for the Comment symbol, which is needed for creating
      // comment nodes with `createVNode`
      context.helper(COMMENT)
      break
    case NodeTypes.INTERPOLATION:
      // no need to traverse, but we need to inject toString helper
      context.helper(TO_STRING)
      break

    // for container types, further traverse downwards
    case NodeTypes.IF:
      for (let i = 0; i < node.branches.length; i++) {
        traverseChildren(node.branches[i], context)
      }
      break
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
      traverseChildren(node, context)
      break
  }

  // exit transforms
  for (let i = 0; i < exitFns.length; i++) {
    exitFns[i]()
  }
}

export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      const exitFns = []
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          props.splice(i, 1)
          i--
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
