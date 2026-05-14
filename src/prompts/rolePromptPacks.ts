import type { AgentRole } from "../domain/types.js";

export interface RolePromptPack {
  role: AgentRole;
  version: string;
  trigger: string;
  description: string;
}

const packs: RolePromptPack[] = [
  {
    role: "agent_brief",
    version: "v1.0.0",
    trigger: "new user message in project dialog",
    description: "Extracts actionable brief fields with minimal-question policy.",
  },
  {
    role: "agent_skeptic",
    version: "v1.0.0",
    trigger: "/analyze or auto-analyze readiness",
    description: "Returns feasibility verdict and safe scope reframing when needed.",
  },
  {
    role: "agent_builder",
    version: "v1.0.0",
    trigger: "/confirm for create/update flow",
    description: "Implements code changes for selected prototype scenario.",
  },
  {
    role: "agent_tester",
    version: "v1.0.0",
    trigger: "after builder code generation",
    description: "Runs technical validation and reports blocking issues.",
  },
  {
    role: "agent_revisor",
    version: "v1.0.0",
    trigger: "after tester stage passes",
    description: "Performs UI/UX and scenario-fit review before deploy.",
  },
  {
    role: "agent_estimator",
    version: "v1.0.0",
    trigger: "/estimate command",
    description: "Produces production resource estimate with structured schema.",
  },
  {
    role: "agent_data_scout",
    version: "v1.0.0",
    trigger: "analyze stage for prototypes without client data",
    description: "Suggests public/open demo data with source traceability.",
  },
];

export function getRolePromptPack(role: AgentRole): RolePromptPack {
  return packs.find((pack) => pack.role === role) ?? {
    role,
    version: "v1.0.0",
    trigger: "manual",
    description: "Default role prompt pack.",
  };
}

export function listRolePromptPacks(): RolePromptPack[] {
  return [...packs];
}
