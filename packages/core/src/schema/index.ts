export type FieldDataType =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "json";

export interface ReferenceMeta {
  model: string;
  column: string;
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

export interface FieldMeta {
  name: string;
  column: string;
  type: FieldDataType;
  primaryKey: boolean;
  unique: boolean;
  nullable: boolean;
  index: boolean;
  autoIncrement: boolean;
  maxLength?: number;
  defaultKind: "none" | "static" | "now" | "uuid";
  defaultValue?: unknown;
  references?: ReferenceMeta;
}

export class FieldBuilder<
  TType,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
> {
  public readonly meta: Omit<FieldMeta, "name">;
  declare readonly __tsType: TType;
  declare readonly __nullable: TNullable;
  declare readonly __hasDefault: THasDefault;

  constructor(type: FieldDataType, overrides: Partial<Omit<FieldMeta, "name">> = {}) {
    this.meta = {
      column: "",
      type,
      primaryKey: false,
      unique: false,
      nullable: false,
      index: false,
      autoIncrement: false,
      defaultKind: "none",
      ...overrides,
    };
  }

  private clone<N = TType, Null extends boolean = TNullable, Def extends boolean = THasDefault>(
    patch: Partial<Omit<FieldMeta, "name">>
  ): FieldBuilder<N, Null, Def> {
    return new FieldBuilder<N, Null, Def>(this.meta.type, { ...this.meta, ...patch });
  }

  column(columnName: string): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ column: columnName });
  }

  primaryKey(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ primaryKey: true });
  }

  unique(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ unique: true });
  }

  index(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ index: true });
  }

  nullable(): FieldBuilder<TType, true, true> {
    return this.clone<TType, true, true>({ nullable: true });
  }

  default(value: TType): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({
      defaultKind: "static",
      defaultValue: value,
    });
  }

  defaultNow(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ defaultKind: "now" });
  }

  defaultRandom(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ defaultKind: "uuid" });
  }

  autoIncrement(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ autoIncrement: true });
  }

  references(
    targetModel: () => ModelDefinition<string, Record<string, AnyFieldBuilder>, Record<string, RelationMeta>>,
    targetColumn: string = "id",
    options?: { onDelete?: ReferenceMeta["onDelete"] }
  ): FieldBuilder<TType, TNullable, THasDefault> {
    const resolved = targetModel();
    return this.clone({
      references: {
        model: resolved.name,
        column: targetColumn,
        onDelete: options?.onDelete ?? "CASCADE",
      },
    });
  }
}

export type AnyFieldBuilder = FieldBuilder<any, any, any>;

export const field = {
  string(opts?: { maxLength?: number }) {
    return new FieldBuilder<string>("string", { maxLength: opts?.maxLength });
  },
  integer() {
    return new FieldBuilder<number>("integer");
  },
  float() {
    return new FieldBuilder<number>("float");
  },
  boolean() {
    return new FieldBuilder<boolean>("boolean");
  },
  uuid() {
    return new FieldBuilder<string>("uuid");
  },
  date() {
    return new FieldBuilder<Date | string>("date");
  },
  timestamp() {
    return new FieldBuilder<Date | string>("timestamp");
  },
  json<T = Record<string, unknown>>() {
    return new FieldBuilder<T>("json");
  },
};

export type RelationKind = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";

export interface RelationMeta<
  TTargetModel extends AnyModelDefinition = AnyModelDefinition,
  TKind extends RelationKind = RelationKind,
> {
  name: string;
  kind: TKind;
  target: string;
  targetModel?: () => TTargetModel;
  foreignKey: string;
  references: string;
  joinTable?: string;
}

export interface ModelOptions {
  tableName?: string;
  relations?: Record<string, Omit<RelationMeta, "name">>;
}

export interface ModelDefinition<
  TName extends string = string,
  TFields extends Record<string, AnyFieldBuilder> = Record<string, AnyFieldBuilder>,
  TRelations extends Record<string, RelationMeta> = Record<string, RelationMeta>,
> {
  readonly name: TName;
  readonly tableName: string;
  readonly fields: TFields;
  readonly relations: TRelations;
  readonly $InferSelect: InferSelectModel<TFields>;
  readonly $InferInsert: InferInsertModel<TFields>;
}

export type AnyModelDefinition = ModelDefinition<string, Record<string, AnyFieldBuilder>, Record<string, RelationMeta>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferFieldSelect<F extends AnyFieldBuilder> = F["__nullable"] extends true
  ? F["__tsType"] | null
  : F["__tsType"];

export type InferSelectModel<TFields extends Record<string, AnyFieldBuilder>> = Simplify<{
  [K in keyof TFields]: InferFieldSelect<TFields[K]>;
}>;

type RequiredInsertKeys<TFields extends Record<string, AnyFieldBuilder>> = {
  [K in keyof TFields]: TFields[K]["__hasDefault"] extends true
    ? never
    : TFields[K]["__nullable"] extends true
      ? never
      : K;
}[keyof TFields];

type OptionalInsertKeys<TFields extends Record<string, AnyFieldBuilder>> = Exclude<
  keyof TFields,
  RequiredInsertKeys<TFields>
>;

export type InferInsertModel<TFields extends Record<string, AnyFieldBuilder>> = Simplify<
  {
    [K in RequiredInsertKeys<TFields>]: InferFieldSelect<TFields[K]>;
  } & {
    [K in OptionalInsertKeys<TFields>]?: InferFieldSelect<TFields[K]>;
  }
>;

export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, (_match, p1: string, offset: number) => (offset > 0 ? "_" : "") + p1.toLowerCase())
    .toLowerCase();
}

export function defineModel<
  TName extends string,
  TFields extends Record<string, AnyFieldBuilder>,
>(
  name: TName,
  fields: TFields,
  options?: ModelOptions
): ModelDefinition<TName, TFields, Record<string, RelationMeta>> {
  const tableName = options?.tableName ?? `${toSnakeCase(name)}s`;
  const relations: Record<string, RelationMeta> = {};

  if (options?.relations) {
    for (const [relName, relDef] of Object.entries(options.relations)) {
      relations[relName] = { ...relDef, name: relName };
    }
  }

  return {
    name,
    tableName,
    fields,
    relations,
    $InferSelect: {} as InferSelectModel<TFields>,
    $InferInsert: {} as InferInsertModel<TFields>,
  };
}

export interface RelationHelpers {
  hasOne<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToOne">, "name">;
  hasMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToMany">, "name">;
  belongsTo<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToOne">, "name">;
  manyToMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { joinTable: string; foreignKey?: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToMany">, "name">;
}

export interface RelationNamespace extends RelationHelpers {
  define<
    TSource extends AnyModelDefinition,
    TRelMap extends Record<string, Omit<RelationMeta<any, any>, "name">>,
  >(
    sourceModel: TSource,
    builder: (helpers: RelationHelpers) => TRelMap
  ): ModelDefinition<
    TSource["name"],
    TSource["fields"],
    { [K in keyof TRelMap]: TRelMap[K] & { name: K & string } }
  >;
}

export const relation: RelationNamespace = {
  hasOne<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToOne">, "name"> {
    return {
      kind: "oneToOne",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  hasMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToMany">, "name"> {
    return {
      kind: "oneToMany",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  belongsTo<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToOne">, "name"> {
    return {
      kind: "manyToOne",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  manyToMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { joinTable: string; foreignKey?: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToMany">, "name"> {
    return {
      kind: "manyToMany",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey ?? "id",
      references: opts.references ?? "id",
      joinTable: opts.joinTable,
    };
  },
  define<
    TSource extends AnyModelDefinition,
    TRelMap extends Record<string, Omit<RelationMeta<any, any>, "name">>,
  >(
    sourceModel: TSource,
    builder: (helpers: RelationHelpers) => TRelMap
  ) {
    const built = builder(relation);
    for (const [relName, relDef] of Object.entries(built)) {
      sourceModel.relations[relName] = {
        ...relDef,
        name: relName,
        target: relDef.targetModel ? relDef.targetModel().name : relDef.target,
      };
    }
    return sourceModel as unknown as ModelDefinition<
      TSource["name"],
      TSource["fields"],
      { [K in keyof TRelMap]: TRelMap[K] & { name: K & string } }
    >;
  },
};

export interface SerializedSchemaManifest {
  models: Array<{
    name: string;
    tableName: string;
    fields: FieldMeta[];
    relations: Array<Omit<RelationMeta, "targetModel">>;
  }>;
}

export function serializeSchema(models: AnyModelDefinition[]): SerializedSchemaManifest {
  return {
    models: models.map((m) => {
      const fieldsRecord = m.fields as Record<string, AnyFieldBuilder>;
      const relationsRecord = m.relations as Record<string, RelationMeta>;
      return {
        name: m.name,
        tableName: m.tableName,
        fields: Object.entries(fieldsRecord).map(([fieldName, builder]) => ({
          ...builder.meta,
          name: fieldName,
          column: builder.meta.column || toSnakeCase(fieldName),
        })),
        relations: Object.values(relationsRecord).map((r) => ({
          name: r.name,
          kind: r.kind,
          target: r.targetModel ? r.targetModel().name : r.target,
          foreignKey: r.foreignKey,
          references: r.references,
          joinTable: r.joinTable,
        })),
      };
    }),
  };
}
