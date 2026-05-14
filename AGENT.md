# AGENT.md — Helm

Este es el agent guidance file de Helm. Léelo al arrancar cualquier sesión.

## Qué es Helm

Producto open source que orquesta el desarrollo de software de calidad para equipos chicos apoyados en IA. Reemplaza patrones de `agent-hq` y los expande con: spec/plan formalizados, multi-repo, knowledge repo separado, issue tracker agnóstico, runtime de agente agnóstico (en v1+).

Persona objetivo: CTO de startup chica que sostiene calidad con poco equipo + agentes IA.

## Diseño y decisiones (fuente de verdad)

Los documentos de diseño viven fuera del repo en:

`/Users/lhpaul/Documents/Emprendimientos/Helm/`

Leé estos antes de tomar decisiones técnicas:

- `00-VISION.md` — visión del producto
- `01-DIAGNOSTICO.md` — análisis cruzado de agent-hq, ai-dev-framework-template, Zeki UX Lab
- `02-ARQUITECTURA.md` — componentes, modelo de dominio, máquina de estados, capas de persistencia
- `04-ROADMAP.md` — 18 sesiones en ~9 semanas a MVP
- `05-V0-SCOPE.md` — scope exacto de v0: qué entra, qué no, decisiones cerradas
- `06-SETUP.md` — credenciales y software requeridos

## Repositorios relacionados (referencias)

- `/Users/lhpaul/Git/MOME/agent-hq` — herramienta existente en MOME. Fuente de patrones técnicos a heredar (orquestador, terminal bridge, fan-out reviewers, cost tracking). Leer su `CLAUDE.md` antes de implementar cualquier patrón que ya esté resuelto ahí.
- `/Users/lhpaul/Git/ai-dev-framework-template` — template del que Helm hereda Spec → Plan → Code, REVIEW.md, branch naming, CHANGELOG. Leer su `AGENTS.md` para entender la filosofía protocol-first.
- `/Users/lhpaul/Git/Helm/helm-knowledge` — knowledge repo del propio Helm: `.helm/product.yaml`, specs, plans, ADRs, retrospectivas.

## Configuración local

Las variables de entorno del server API viven en `apps/api/.env` (no en la raíz).
Bun lee `.env` del directorio de trabajo del proceso — que es `apps/api/` cuando Turbo lanza el dev server.

Para arrancar localmente: `cp apps/api/.env.example apps/api/.env` y completar los valores.

| Variable                   | Paquete    | Descripción                                                                                                                            |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `HELM_KNOWLEDGE_REPO_PATH` | `apps/api` | Path absoluto al knowledge repo del Product activo (donde vive `.helm/product.yaml`). Ejemplo: `/Users/lhpaul/Git/Helm/helm-knowledge` |

Si en el futuro `apps/web` necesita variables de entorno, irán en `apps/web/.env.example` / `apps/web/.env` por separado.
No centralizamos en root para no necesitar dotenv-cli overhead.

## Stack confirmado (v0)

- Backend: Bun + TypeScript + Hono. Sin DB.
- Frontend: React 18 + Tailwind + Vite.
- Monorepo: pnpm workspaces + Turborepo.
- Persistencia: GitHub Projects/Linear (workflow) + knowledge repo (artefactos) + filesystem `data/` (operativo).
- Runtime de agentes (v0): solo Claude Code spawn. Abstracción `AgentRuntimeAdapter` lista para agregar runtimes en v1+.

## Decisiones cerradas

1. Sin UX Lab en v0 (queda preparado para v1).
2. Sin DB local. Linear/GitHub Projects + git + filesystem.
3. Issue tracker agnóstico vía `IssueTrackerAdapter`. v0: GitHub Projects (Sesión 5), Linear (Sesión 11).
4. Knowledge repo separado por producto.
5. 5 specialists en MVP: spec-writer, plan-writer, implementer, 3 reviewers, remediation.
6. Open source desde día uno (Apache 2.0).
7. Piloto MOME contra repo de prueba primero.

## Convenciones

- Branch naming: `feature/*`, `fix/*`, `refactor/*` desde `develop`; `hotfix/*`, `release/v*` desde `main`. Hereda de `ai-dev-framework-template`.
- CHANGELOG: Keep a Changelog + SemVer. Feature/fix PRs agregan a `[Unreleased]` en develop. Hotfixes versionan directo en main.
- No `git push --force` ni `git reset --hard` en shared branches sin OK explícito.
- Stop y preguntar si una acción parece destructiva.

## Sesión actual

Sesión 2: bootstrap del monorepo. Tres bloques:

1. Scaffold pnpm + Turborepo con `apps/web` + `apps/api` + `packages/*`.
2. Tooling base: TypeScript shared config, ESLint + Prettier, Vitest, Husky.
3. Esqueletos: Hono `/health`, React + Vite + Tailwind con WS trivial.

Meta: `pnpm dev` levanta server + dashboard, primer commit pusheado.
