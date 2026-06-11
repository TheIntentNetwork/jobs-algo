/** Exponentially Weighted Moving Average with configurable alpha */
export class EWMA {
  private value: number;
  private _count: number = 0;

  constructor(
    private readonly alpha: number,
    initialValue: number,
  ) {
    this.value = initialValue;
  }

  /** Push a new observation and return the updated average */
  update(observation: number): number {
    if (this._count === 0) {
      // First real observation — seed it directly
      this.value = observation;
    } else {
      this.value = this.alpha * observation + (1 - this.alpha) * this.value;
    }
    this._count++;
    return this.value;
  }

  /** Current EWMA value */
  current(): number {
    return this.value;
  }

  /** Number of observations pushed */
  count(): number {
    return this._count;
  }

  /** Serialize for persistence */
  toJSON(): { value: number; count: number; alpha: number } {
    return { value: this.value, count: this._count, alpha: this.alpha };
  }

  /** Restore from persisted state */
  static fromJSON(data: { value: number; count: number; alpha: number }): EWMA {
    const e = new EWMA(data.alpha, 0);
    e.value = data.value;
    e._count = data.count;
    return e;
  }
}
