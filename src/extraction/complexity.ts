/**
 * Cyclomatic and cognitive complexity computation.
 *
 * Cyclomatic complexity: McCabe's metric — number of linearly independent paths.
 *   CC = 1 + decision points
 *   Decision points: if, else if, for, while, do, switch case, catch, &&, ||, ??, ?:
 *
 * Nesting depth: max depth of nested control-flow blocks.
 *
 * Maintainability index (simplified): MI = 171 − 5.2×ln(V) − 0.23×CC − 16.2×ln(LOC)
 *   where V = Halstead volume (approximated from unique tokens).
 *
 * These are computed from tree-sitter AST nodes.
 * Pass `node` = the function/method tree-sitter node and `source` = the full file source.
 */

/** Node types that increment cyclomatic complexity. */
const CC_NODE_TYPES = new Set([
  'if_statement', 'elif_clause', 'else_clause',
  'for_statement', 'for_in_statement', 'enhanced_for_statement',
  'while_statement', 'do_statement',
  'switch_case', 'case_clause',
  'catch_clause', 'except_clause',
  'conditional_expression', 'ternary_expression',
  'logical_and', 'logical_or', 'binary_expression',  // && and || covered via binary_expression type check
  'null_coalescing_expression', 'optional_chain',
  'match_arm', 'when_entry',  // Rust/Kotlin match
]);

/** Binary expression operator tokens that count as decision points. */
const CC_OPERATORS = new Set(['&&', '||', '??', 'and', 'or']);

/** Control-flow block node types that increase nesting depth. */
const NESTING_TYPES = new Set([
  'if_statement', 'for_statement', 'for_in_statement', 'enhanced_for_statement',
  'while_statement', 'do_statement', 'switch_statement', 'try_statement',
  'with_statement', 'block', 'function_body', 'method_body',
]);

/** Walk a tree-sitter node tree recursively to compute complexity metrics. */
function walkComplexity(node: any, depth: number, maxDepth: { value: number }): number {
  let cc = 0;

  if (CC_NODE_TYPES.has(node.type)) {
    // For binary expressions, only count if the operator is a boolean one
    if (node.type === 'binary_expression') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && CC_OPERATORS.has(child.type)) cc++;
      }
    } else {
      cc++;
    }
  }

  if (NESTING_TYPES.has(node.type)) {
    const d = depth + 1;
    if (d > maxDepth.value) maxDepth.value = d;
    for (let i = 0; i < node.childCount; i++) {
      cc += walkComplexity(node.child(i), d, maxDepth);
    }
  } else {
    for (let i = 0; i < node.childCount; i++) {
      cc += walkComplexity(node.child(i), depth, maxDepth);
    }
  }

  return cc;
}

export interface ComplexityMetrics {
  cyclomaticComplexity: number;
  nestingDepth: number;
  maintainabilityIndex: number;
  loc: number;
}

/**
 * Compute complexity metrics for a function/method AST node.
 * @param node  tree-sitter Node for the function
 * @param source  full file source string (used for LOC and halstead approximation)
 */
export function computeComplexity(node: any, source: string): ComplexityMetrics {
  const maxDepth = { value: 0 };
  const decisionPoints = walkComplexity(node, 0, maxDepth);
  const cyclomaticComplexity = 1 + decisionPoints;
  const nestingDepth = maxDepth.value;

  // LOC = lines spanned by this node
  const loc = (node.endPosition.row - node.startPosition.row) + 1;

  // Approximate Halstead volume from unique tokens in this node's text
  const nodeText = source.slice(node.startIndex, node.endIndex);
  const tokens = nodeText.match(/\b\w+\b|[+\-*/=<>!&|^~%]+|[(){}[\],;.]/g) ?? [];
  const uniqueTokens = new Set(tokens);
  const vocabulary = uniqueTokens.size;
  const length = tokens.length;
  const volume = length > 0 && vocabulary > 1 ? length * Math.log2(vocabulary) : 0;

  // Maintainability index (clamped 0–100)
  const mi = Math.max(0, Math.min(100,
    171 - 5.2 * Math.log(Math.max(1, volume)) - 0.23 * cyclomaticComplexity - 16.2 * Math.log(Math.max(1, loc))
  ));

  return {
    cyclomaticComplexity,
    nestingDepth,
    maintainabilityIndex: Math.round(mi * 10) / 10,
    loc,
  };
}
