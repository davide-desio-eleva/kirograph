import { BaseService } from './base';
import { Repository } from './base';
/** God class with too many responsibilities */
export class UserService extends BaseService implements Repository<string> {
  process(input: string): string { return input; }
  findById(id: string): string | null { return id; }
  findAll(): string[] { return []; }
  create(name: string): string { return name; }
  update(id: string, name: string): void {}
  delete(id: string): void {}
  validate2(input: string): boolean { return true; }
  format(input: string): string { return input.trim(); }
  transform(input: string): string { return input.toLowerCase(); }
  export(): string[] { return []; }
}
