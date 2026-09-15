import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrainStatus } from "./brain-status";
import { registerCreative } from "./creative";
import { registerHabit } from "./habit";
import { registerPlan } from "./plan";
import { registerRecall } from "./recall";
import { registerRemember } from "./remember";
import { registerSearch } from "./search";
import { registerThink } from "./think";

export function registerTools(pi: ExtensionAPI) {
  registerRemember(pi);
  registerRecall(pi);
  registerSearch(pi);
  registerThink(pi);
  registerCreative(pi);
  registerPlan(pi);
  registerHabit(pi);
  registerBrainStatus(pi);
}