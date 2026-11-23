import { invoke as run } from "../store";
export const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => run(command, args) as T;
