/**
 * A stand-in for the Drizzle `db` singleton.
 *
 * Drizzle builds queries as a fluent chain that is only executed when awaited:
 *
 *   await db.select({ … }).from(users).where(eq(…)).orderBy(…).limit(1)
 *
 * so the stub has to be two things at once — an object whose every method
 * returns itself, and a thenable that resolves to rows. A Proxy gives both: any
 * property read returns a chainable function, except `then`, which drains the
 * next queued result.
 *
 * Results are consumed in call order. A service issuing three queries needs
 * three `queueRows` calls, which keeps each test explicit about the database
 * state it is describing.
 *
 * The `trace` records every call, so a test can assert *how* a query was built
 * where that is the actual contract — `.for('update')` on the reaction read, for
 * instance, is the row lock that stops two concurrent reactions computing a
 * count from the same stale array.
 */

export type Row = Record<string, unknown>;

export interface DbMock {
  /** Passed to `vi.mock` as the replacement for the real `db` export. */
  db: Record<string, unknown>;
  /** Queue one result set, returned by the next awaited query. */
  queueRows(rows: Row[]): void;
  /** Queue several result sets at once, in the order the code will run them. */
  queueMany(...rowSets: Row[][]): void;
  /** Every chained call, in order, as `"select"`, `"from"`, `"where"`, … */
  trace: { method: string; args: unknown[] }[];
  /** True when `method` appears anywhere in the trace. */
  called(method: string): boolean;
  reset(): void;
}

export function createDbMock(): DbMock {
  const results: Row[][] = [];
  const trace: { method: string; args: unknown[] }[] = [];

  const makeChain = (): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          // Awaiting the chain runs it. An empty queue yields no rows, which
          // is the honest default: "the database matched nothing".
          if (prop === 'then') {
            return (
              onFulfilled?: (v: Row[]) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) => {
              const rows = results.length > 0 ? results.shift()! : [];
              return Promise.resolve(rows).then(onFulfilled, onRejected);
            };
          }
          // Promise machinery and console formatting probe for symbols; they
          // must not be mistaken for query builder methods.
          if (typeof prop === 'symbol') return undefined;

          return (...args: unknown[]) => {
            trace.push({ method: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const entry = (name: string) => (...args: unknown[]) => {
    trace.push({ method: name, args });
    return makeChain();
  };

  const db: Record<string, unknown> = {
    select: entry('select'),
    insert: entry('insert'),
    update: entry('update'),
    delete: entry('delete'),
    execute: entry('execute'),
    // Services run multi-statement work inside a transaction and use the `tx`
    // handle exactly as they use `db`, so handing back the same object keeps
    // the queued results flowing in one sequence.
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      trace.push({ method: 'transaction', args: [] });
      return cb(db);
    },
  };

  return {
    db,
    queueRows: (rows) => void results.push(rows),
    queueMany: (...rowSets) => void results.push(...rowSets),
    trace,
    called: (method) => trace.some((c) => c.method === method),
    reset: () => {
      results.length = 0;
      trace.length = 0;
    },
  };
}

