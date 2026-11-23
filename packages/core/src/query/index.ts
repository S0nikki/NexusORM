import type { AnyModelDefinition, InferSelectModel } from "../schema/index.js";

export type ComparisonOperator<T> = {
  eq?: T;
  neq?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: T[];
  notIn?: T[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  isNull?: boolean;
};

export type FieldFilter<T> = T | ComparisonOperator<T>;

export type WhereFilter<TModel extends AnyModelDefinition> = {
  [K in keyof InferSelectModel<TModel["fields"]>]?: FieldFilter<
    InferSelectModel<TModel["fields"]>[K]
  >;
} & {
  AND?: WhereFilter<TModel>[];
  OR?: WhereFilter<TModel>[];
  NOT?: WhereFilter<TModel>;
};

export type OrderDirection = "asc" | "desc";

export type OrderByInput<TModel extends AnyModelDefinition> = {
  [K in keyof InferSelectModel<TModel["fields"]>]?: OrderDirection;
};

export type SelectInput<TModel extends AnyModelDefinition> =
  | Array<keyof InferSelectModel<TModel["fields"]> & string>
  | {
      [K in keyof InferSelectModel<TModel["fields"]>]?: boolean;
    };

export type IncludeOption =
  | boolean
  | {
      where?: Record<string, unknown>;
      select?: string[];
      orderBy?: Record<string, OrderDirection>;
      limit?: number;
      offset?: number;
      include?: Record<string, IncludeOption>;
    };

export type IncludeInput<TModel extends AnyModelDefinition> = {
  [K in keyof TModel["relations"]]?: IncludeOption;
} & Record<string, IncludeOption | undefined>;

export interface FilterASTNode {
  field?: string;
  op?: string;
  value?: unknown;
  AND?: FilterASTNode[];
  OR?: FilterASTNode[];
  NOT?: FilterASTNode;
}

export interface OrderByASTNode {
  field: string;
  dir: OrderDirection;
}

export interface IncludeASTNode {
  where?: FilterASTNode;
  select?: string[];
  orderBy?: OrderByASTNode[];
  limit?: number;
  offset?: number;
  include?: Record<string, IncludeASTNode>;
}

const KNOWN_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "isNull",
]);

function isOperatorObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val) || val instanceof Date) {
    return false;
  }
  const keys = Object.keys(val);
  return keys.length > 0 && keys.every((k) => KNOWN_OPERATORS.has(k));
}

export function normalizeWhereToAST(where?: Record<string, unknown>): FilterASTNode | undefined {
  if (!where || Object.keys(where).length === 0) {
    return undefined;
  }

  const andNodes: FilterASTNode[] = [];

  for (const [key, rawVal] of Object.entries(where)) {
    if (rawVal === undefined) continue;

    if (key === "AND" && Array.isArray(rawVal)) {
      const children = rawVal
        .map((item) => normalizeWhereToAST(item as Record<string, unknown>))
        .filter((n): n is FilterASTNode => Boolean(n));
      if (children.length > 0) {
        andNodes.push({ AND: children });
      }
      continue;
    }

    if (key === "OR" && Array.isArray(rawVal)) {
      const children = rawVal
        .map((item) => normalizeWhereToAST(item as Record<string, unknown>))
        .filter((n): n is FilterASTNode => Boolean(n));
      if (children.length > 0) {
        andNodes.push({ OR: children });
      }
      continue;
    }

    if (key === "NOT" && rawVal && typeof rawVal === "object") {
      const child = normalizeWhereToAST(rawVal as Record<string, unknown>);
      if (child) {
        andNodes.push({ NOT: child });
      }
      continue;
    }

    if (isOperatorObject(rawVal)) {
      for (const [op, opVal] of Object.entries(rawVal)) {
        andNodes.push({
          field: key,
          op,
          value: opVal instanceof Date ? opVal.toISOString() : opVal,
        });
      }
    } else {
      andNodes.push({
        field: key,
        op: "eq",
        value: rawVal instanceof Date ? rawVal.toISOString() : rawVal,
      });
    }
  }

  if (andNodes.length === 0) return undefined;
  if (andNodes.length === 1) return andNodes[0];
  return { AND: andNodes };
}

export function normalizeSelectToAST<TModel extends AnyModelDefinition>(
  select?: SelectInput<TModel>
): string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) return select;
  const fields = Object.entries(select)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([field]) => field);
  return fields.length > 0 ? fields : undefined;
}

export function normalizeOrderByToAST<TModel extends AnyModelDefinition>(
  orderBy?: OrderByInput<TModel> | Array<OrderByInput<TModel>>
): OrderByASTNode[] | undefined {
  if (!orderBy) return undefined;
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: OrderByASTNode[] = [];
  for (const item of items) {
    for (const [field, dir] of Object.entries(item)) {
      if (dir === "asc" || dir === "desc") {
        out.push({ field, dir });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeIncludeToAST<TModel extends AnyModelDefinition>(
  include?: IncludeInput<TModel>
): Record<string, IncludeASTNode> | undefined {
  if (!include) return undefined;
  const out: Record<string, IncludeASTNode> = {};
  for (const [relName, opt] of Object.entries(include)) {
    if (!opt) continue;
    if (opt === true) {
      out[relName] = {};
    } else if (typeof opt === "object") {
      out[relName] = {
        where: normalizeWhereToAST(opt.where),
        select: opt.select,
        orderBy: normalizeOrderByToAST(opt.orderBy as any),
        limit: opt.limit,
        offset: opt.offset,
        include: normalizeIncludeToAST(opt.include as any),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
