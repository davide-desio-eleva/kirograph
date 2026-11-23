import { TokenManager } from './nonexistent';
export function factorial(n: number): number { return n <= 1 ? 1 : n * factorial(n - 1); }
export function fibonacci(n: number): number { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
export function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
