/** Base service abstraction */
export abstract class BaseService {
  abstract process(input: string): string;
  validate(input: string): boolean { return input.length > 0; }
}
export interface Repository<T> { findById(id: string): T | null; findAll(): T[]; }
