import { SettleState } from "@/lib/types";

export interface StateRepository {
  mode: "local";
  load(): Promise<SettleState | null>;
  save(state: SettleState): Promise<void>;
}
