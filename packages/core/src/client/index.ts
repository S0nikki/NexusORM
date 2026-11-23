import { EngineBridge } from "../bridge/engine-bridge.js";
import type { NexusConfig } from "../config/index.js";
import { NexusError } from "../errors/index.js";
import {
  normalizeIncludeToAST,
  normalizeOrderByToAST,
  normalizeSelectToAST,
  normalizeWhereToAST,
  type IncludeInput,
  type OrderByInput,
  type SelectInput,
  type WhereFilter,
} from "../query/index.js";
import {
  buildModelMeta,
  compileSelectSQL,
  type CompiledSQLQuery,
  type InternalModelMeta,
} from "../query/sql-compiler.js";
import {
  serializeSchema,
  type AnyModelDefinition,
  type InferInsertModel,
  type InferSelectModel,
} from "../schema/index.js";

export interface FindManyArgs<TModel extends AnyModelDefinition> {
  where?: WhereFilter<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
  orderBy?: OrderByInput<TModel> | Array<OrderByInput<TModel>>;
  limit?: number;
  offset?: number;
}

export interface CreateArgs<TModel extends AnyModelDefinition> {
  data: InferInsertModel<TModel["fields"]> & Record<string, unknown>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}

export interface CreateManyArgs<TModel extends AnyModelDefinition> {
  data: Array<InferInsertModel<TModel["fields"]>>;
}

export interface UpdateArgs<TModel extends AnyModelDefinition> {
  where: WhereFilter<TModel>;
  data: Partial<InferInsertModel<TModel["fields"]>>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}

export interface DeleteArgs<TModel extends AnyModelDefinition> {
  where: WhereFilter<TModel>;
}

export class ModelDelegate<TModel extends AnyModelDefinition> {
  private readonly meta: InternalModelMeta;

  constructor(
    private readonly model: TModel,
    private readonly bridge: EngineBridge,
    private readonly ensureConnected: () => Promise<void>,
    private readonly txId?: string
  ) {
    this.meta = buildModelMeta(model);
  }

  private async exec(operation: string, payload: Record<string, unknown>) {
    await this.ensureConnected();
    return this.bridge.request("query.execute", {
      txId: this.txId,
      model: this.model.name,
      operation,
      ...payload,
    });
  }

  /**
   * Compiles a query directly to parameterized SQL and bind parameters in TypeScript
   * (just like Drizzle's .toSQL()) without spawning or hitting the Go engine.
   */
  toSQL(args: FindManyArgs<TModel> = {}): CompiledSQLQuery {
    return compileSelectSQL(this.meta, {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      orderBy: normalizeOrderByToAST(args.orderBy),
      limit: args.limit,
      offset: args.offset,
    });
  }

  async findMany(
    args: FindManyArgs<TModel> = {}
  ): Promise<Array<InferSelectModel<TModel["fields"]> & Record<string, any>>> {
    const res = await this.exec("findMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
      orderBy: normalizeOrderByToAST(args.orderBy),
      limit: args.limit,
      offset: args.offset,
    });
    return res.rows ?? [];
  }

  async findFirst(
    args: FindManyArgs<TModel> = {}
  ): Promise<(InferSelectModel<TModel["fields"]> & Record<string, any>) | null> {
    const res = await this.exec("findFirst", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
      orderBy: normalizeOrderByToAST(args.orderBy),
      offset: args.offset,
    });
    return res.row ?? null;
  }

  async findUnique(
    args: FindManyArgs<TModel>
  ): Promise<(InferSelectModel<TModel["fields"]> & Record<string, any>) | null> {
    const res = await this.exec("findUnique", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row ?? null;
  }

  async create(
    args: CreateArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]> & Record<string, any>> {
    const res = await this.exec("create", {
      data: args.data,
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row;
  }

  async createMany(args: CreateManyArgs<TModel>): Promise<{ count: number }> {
    const res = await this.exec("createMany", {
      dataList: args.data,
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async update(
    args: UpdateArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]> & Record<string, any>> {
    const res = await this.exec("update", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      data: args.data,
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row;
  }

  async updateMany(
    args: UpdateArgs<TModel>
  ): Promise<{ count: number }> {
    const res = await this.exec("updateMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      data: args.data,
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async delete(
    args: DeleteArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]>> {
    const res = await this.exec("delete", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return res.row;
  }

  async deleteMany(
    args: { where?: WhereFilter<TModel> } = {}
  ): Promise<{ count: number }> {
    const res = await this.exec("deleteMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async count(
    args: { where?: WhereFilter<TModel> } = {}
  ): Promise<number> {
    const res = await this.exec("count", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return Number(res.count ?? 0);
  }

  async exists(where: WhereFilter<TModel>): Promise<boolean> {
    const res = await this.exec("exists", {
      where: normalizeWhereToAST(where as Record<string, unknown>),
    });
    return Boolean(res.exists);
  }
}

export type UncapitalizeModelMap<TModels extends Record<string, AnyModelDefinition>> = {
  [K in keyof TModels as Uncapitalize<TModels[K]["name"]>]: ModelDelegate<TModels[K]>;
};

export interface CreateClientOptions<TModels extends Record<string, AnyModelDefinition>> {
  config: NexusConfig;
  models: TModels;
}

export class BaseNexusClient<TModels extends Record<string, AnyModelDefinition>> {
  public readonly $bridge: EngineBridge;
  public readonly $config: NexusConfig;
  public readonly $models: TModels;
  private isConnected = false;

  constructor(opts: CreateClientOptions<TModels>, existingBridge?: EngineBridge, txId?: string) {
    this.$config = opts.config;
    this.$models = opts.models;
    this.$bridge =
      existingBridge ??
      new EngineBridge({
        binaryPath: opts.config.engineBinaryPath,
        executionMode: opts.config.executionMode,
        dialect: opts.config.dialect,
      });

    if (!existingBridge) {
      this.$bridge.setReplayHook(async () => {
        this.isConnected = false;
        await this.$connect();
      });
    } else {
      this.isConnected = true;
    }

    for (const model of Object.values(opts.models)) {
      const propName = model.name.charAt(0).toLowerCase() + model.name.slice(1);
      Object.defineProperty(this, propName, {
        value: new ModelDelegate(model, this.$bridge, () => this.$connect(), txId),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }

  async $connect(): Promise<void> {
    if (this.isConnected) return;
    await this.$bridge.start();
    await this.$bridge.request("engine.connect", {
      dialect: this.$config.dialect,
      url: this.$config.connection.url,
      pool: this.$config.connection.pool,
      logLevel: this.$config.logging.level,
    });
    const manifest = serializeSchema(Object.values(this.$models));
    await this.$bridge.request("schema.register", manifest);
    this.isConnected = true;
  }

  async $pushSchema(): Promise<void> {
    await this.$connect();
    const manifest = serializeSchema(Object.values(this.$models));
    await this.$bridge.request("schema.register", manifest);
    await this.$bridge.request("schema.push", {});
  }

  async $transaction<R>(
    fn: (tx: NexusClient<TModels>) => Promise<R>,
    options: { timeoutMs?: number } = {}
  ): Promise<R> {
    await this.$connect();
    const { txId } = await this.$bridge.request<{ txId: string }>("tx.begin", {
      timeoutMs: options.timeoutMs ?? 15_000,
    });

    const txClient = new BaseNexusClient(
      { config: this.$config, models: this.$models },
      this.$bridge,
      txId
    ) as NexusClient<TModels>;

    try {
      const result = await fn(txClient);
      await this.$bridge.request("tx.commit", { txId });
      return result;
    } catch (err) {
      try {
        await this.$bridge.request("tx.rollback", { txId });
      } catch {
        // ignore rollback error if tx already expired
      }
      if (err instanceof NexusError) throw err;
      throw new NexusError({
        code: "NEXUS_INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  }

  async $disconnect(): Promise<void> {
    await this.$bridge.stop();
    this.isConnected = false;
  }
}

export type NexusClient<TModels extends Record<string, AnyModelDefinition>> =
  BaseNexusClient<TModels> & UncapitalizeModelMap<TModels>;

export function createClient<TModels extends Record<string, AnyModelDefinition>>(
  opts: CreateClientOptions<TModels>
): NexusClient<TModels> {
  return new BaseNexusClient(opts) as NexusClient<TModels>;
}
