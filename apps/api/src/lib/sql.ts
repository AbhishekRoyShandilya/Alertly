/**
 * Builds a WHERE clause from optional filters while keeping every value a `?` parameter.
 *
 *   const w = new Where().add('d.user_id = ?', userId).addIf(f.status, 'd.status = ?', f.status);
 *   query(db, `SELECT … WHERE ${w.sql}`, w.params)
 */
export class Where {
  private parts: string[] = [];
  readonly params: unknown[] = [];

  add(sql: string, ...values: unknown[]): this {
    this.parts.push(sql);
    this.params.push(...values);
    return this;
  }

  /** Adds the condition only when `value` is set (not undefined/null). */
  addIf(value: unknown, sql: string, ...values: unknown[]): this {
    return value === undefined || value === null ? this : this.add(sql, ...values);
  }

  get sql(): string {
    return this.parts.length ? this.parts.join(' AND ') : 'TRUE';
  }
}
