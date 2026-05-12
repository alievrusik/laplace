import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { slugify } from "../domain/slug.js";

export interface ProvisionedProject {
  slug: string;
  localPath: string;
  fullName: string;
  repoId: number;
  repoUrl: string;
  cloneUrl: string;
  pushUrl: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export class ProjectProvisioner {
  private readonly octokit: Octokit;

  constructor(
    private readonly config: {
      token: string;
      owner: string;
      visibility: "private" | "public";
      workspaceDir: string;
    },
  ) {
    this.octokit = new Octokit({ auth: config.token });
  }

  async provision(projectName: string): Promise<ProvisionedProject> {
    const slug = slugify(projectName);
    const localPath = path.join(this.config.workspaceDir, slug);
    await fs.mkdir(localPath, { recursive: true });
    await this.applyTemplateScaffold(localPath, slug);

    const viewer = await this.octokit.users.getAuthenticated();
    const repo = await this.createRepo(slug, viewer.data.login);

    return {
      slug,
      localPath,
      fullName: repo.full_name,
      repoId: repo.id,
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      pushUrl: repo.clone_url.replace("https://", `https://x-access-token:${this.config.token}@`),
      gitAuthorName: viewer.data.name ?? viewer.data.login,
      gitAuthorEmail: `${viewer.data.id}+${viewer.data.login}@users.noreply.github.com`,
    };
  }

  async resolveExisting(projectName: string): Promise<ProvisionedProject> {
    const slug = slugify(projectName);
    const localPath = path.join(this.config.workspaceDir, slug);
    const viewer = await this.octokit.users.getAuthenticated();
    const response = await this.octokit.repos.get({
      owner: this.config.owner,
      repo: slug,
    });
    const repo = response.data;

    await fs.mkdir(localPath, { recursive: true });

    return {
      slug,
      localPath,
      fullName: repo.full_name,
      repoId: repo.id,
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      pushUrl: repo.clone_url.replace("https://", `https://x-access-token:${this.config.token}@`),
      gitAuthorName: viewer.data.name ?? viewer.data.login,
      gitAuthorEmail: `${viewer.data.id}+${viewer.data.login}@users.noreply.github.com`,
    };
  }

  async deleteRepo(projectName: string): Promise<"deleted" | "not_found"> {
    const slug = slugify(projectName);
    try {
      await this.octokit.repos.delete({
        owner: this.config.owner,
        repo: slug,
      });
      return "deleted";
    } catch (error: unknown) {
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      if (status === 404) return "not_found";
      throw error;
    }
  }

  private async createRepo(name: string, authenticatedLogin: string) {
    const isAuthenticatedUser = authenticatedLogin.toLowerCase() === this.config.owner.toLowerCase();

    try {
      const response = isAuthenticatedUser
        ? await this.octokit.repos.createForAuthenticatedUser({
            name,
            private: this.config.visibility === "private",
            auto_init: false,
          })
        : await this.octokit.repos.createInOrg({
            org: this.config.owner,
            name,
            private: this.config.visibility === "private",
            auto_init: false,
          });
      return response.data;
    } catch (error: unknown) {
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      if (status !== 422) throw error;

      const response = await this.octokit.repos.get({
        owner: this.config.owner,
        repo: name,
      });
      return response.data;
    }
  }

  private async applyTemplateScaffold(localPath: string, projectSlug: string): Promise<void> {
    const entries = await fs.readdir(localPath).catch(() => []);
    if (entries.length > 0) return;

    const files: Record<string, string> = {
      ".gitignore": `node_modules
.next
dist
.env
.env.local
*.log
`,
      "package.json": `{
  "name": "${projectSlug}",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "latest",
    "react": "latest",
    "react-dom": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@eslint/eslintrc": "latest",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "eslint": "latest",
    "eslint-config-next": "latest",
    "typescript": "latest"
  }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`,
      "next-env.d.ts": `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`,
      "next.config.mjs": `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`,
      "eslint.config.mjs": `import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];
`,
      "app/globals.css": `:root {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Inter, Arial, sans-serif;
  background: #f7f7f8;
  color: #111827;
}
`,
      "app/layout.tsx": `import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Laplace Prototype",
  description: "AI/ML prototype scaffold",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
`,
      "app/page.tsx": `export default function HomePage() {
  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: "0 16px" }}>
      <h1>Laplace Prototype Scaffold</h1>
      <p>Этот проект создан из шаблона. Builder заполнит его под конкретный use case.</p>
    </main>
  );
}
`,
      "lib/foundation.ts": `export type PrototypeResult = {
  status: "ok" | "warning" | "critical";
  summary: string;
  details?: string[];
};

export function notImplementedResult(): PrototypeResult {
  return {
    status: "warning",
    summary: "Foundation flow is not implemented yet.",
    details: ["Builder should replace this scaffold with project-specific logic."],
  };
}
`,
      "README.md": `# ${projectSlug}

AI/ML prototype scaffold generated by Laplace.

## Local Run

\`\`\`bash
npm install
npm run dev
\`\`\`

## Checks

\`\`\`bash
npm run typecheck
npm run build
\`\`\`
`,
      "prototype.md": `# ${projectSlug}

## Summary
Scaffold placeholder. Builder should replace this section.

## Domain
AI/ML prototype

## Task Type
unknown

## Inputs
To be defined by builder.

## Output
To be defined by builder.

## Approach
Server-side foundation model integration.

## Reuse Notes
Generated from shared Laplace template.

## Links
- Repo:
- Demo:

## Limitations
Initial scaffold only.
`,
      ".cursor/rules/laplace-prototype.md": `# Laplace Prototype Rules

- Keep foundation model calls server-side.
- Do not leak secrets to client or NEXT_PUBLIC variables.
- Maintain working scripts: dev, build, typecheck.
- Keep README and prototype.md up to date.
`,
    };

    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(localPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }
  }
}
