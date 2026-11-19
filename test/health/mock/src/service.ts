import { DataProcessor } from './processor';
export class Service {
  private p = new DataProcessor();
  run(items: unknown[]): unknown[] { return this.p.processAll(items); }
}
