/**
 * Worker entry for the search. Vite turns the `new Worker(new URL(...))` in
 * `engine.ts`'s factory into a real worker bundle; all this file does is hand
 * the shared handler its global scope.
 */
import { installWorkerHandler } from '@ccx/ai';

installWorkerHandler(self as unknown as Parameters<typeof installWorkerHandler>[0]);
