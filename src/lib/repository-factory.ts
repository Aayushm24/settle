import { createLocalRepository } from "@/lib/local-repository";
import { StateRepository } from "@/lib/repository";

export function createRepository(): StateRepository {
  return createLocalRepository();
}
