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

### Secrets con 1Password (recomendado)

Los secretos viven en 1Password; referencias `op://` en `apps/api/.env.template`.
Paths locales y `GITHUB_TOKEN` van en `apps/api/.env.local` (gitignored).

```bash
cp apps/api/.env.local.example apps/api/.env.local
# Editar .env.local: HELM_KNOWLEDGE_REPO_PATH, HELM_DATA_DIR, GITHUB_TOKEN

pnpm sync-env   # op inject → apps/api/.env (correr tras rotar secrets o cambiar .env.local)
pnpm dev
```

Requisitos: [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) y sesión activa (`op signin`).

| Archivo              | Commitear | Contenido                           |
| -------------------- | --------- | ----------------------------------- |
| `.env.template`      | sí        | Referencias `op://` a secretos      |
| `.env.local.example` | sí        | Plantilla de paths locales          |
| `.env.local`         | no        | Tus paths + token GitHub            |
| `.env`               | no        | Generado por `sync-env`; lo lee Bun |

### Variables

| Variable                   | Dónde definirla | Descripción                                                                                                                            |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `HELM_KNOWLEDGE_REPO_PATH` | `.env.local`    | Path absoluto al knowledge repo del Product activo (donde vive `.helm/product.yaml`). Ejemplo: `/Users/lhpaul/Git/Helm/helm-knowledge` |
| `HELM_DATA_DIR`            | `.env.local`    | Path absoluto a `data/` operativo (default: `apps/api/data`)                                                                           |
| `GITHUB_TOKEN`             | `.env.local`    | PAT GitHub o salida de `gh auth token`                                                                                                 |
| `LINEAR_API_KEY`           | `.env.template` | PAT Linear (resuelto por 1Password)                                                                                                    |
| `GITHUB_WEBHOOK_SECRET`    | `.env.template` | Secret del webhook GitHub (resuelto por 1Password)                                                                                     |

Setup manual sin 1Password: copiar `apps/api/.env.example`, crear `.env` a mano con todos los valores en claro (no recomendado para secretos).

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

## Flujo de trabajo asíncrono (autonomía en PRs)

Para reducir round-trips humanos en cada bloque de sesión, Claude Code tiene autonomía documentada para operaciones mecánicas. La regla mental: humano filtra decisiones estratégicas; Claude Code ejecuta lo predecible.

### Claude Code PUEDE hacer autónomamente:

- Ejecutar `pnpm turbo run test`, `build`, `lint` y reportar resultado en el PR description.
- Aplicar fixes de CodeRabbit que caen en categorías ya catched antes (path traversal en inputs externos, info leak de paths/tokens en error responses, race conditions en singletons o init, validación estricta con Zod `.strict()`, sanitización de inputs). Si el fix es claramente uno de estos patrones, aplicalo y commitea con `fix(...)` + "Addresses CodeRabbit review comment on PR #N".
- Esperar a CodeRabbit después de cada push usando polling (ver sección "Reviewer loop básico" abajo).
- Mergear el PR con `gh pr merge N --merge --delete-branch` después de:
  1. Confirmar que tests, build y lint están verdes localmente.
  2. Confirmar que CodeRabbit reportó "No actionable comments" o solo nitpicks dismissables.
  3. Pull del develop y switch a develop después del merge.

### Claude Code DEBE parar y pedir input humano si:

- Surge una decisión arquitectónica no cubierta en el plan high-level aprobado al inicio del bloque.
- CodeRabbit reporta un finding que requiere refactor sustantivo (no fix puntual).
- Tests fallan más de 2 retries seguidos sin pattern claro de fix.
- Hay conflict de merge con develop.
- El plan de un Bloque excede 90 minutos de tiempo estimado.
- Surge una limitación técnica que requiere agregar/cambiar dependencias significativas no previstas.

### Reviewer loop básico para CodeRabbit

Después de cada push a la feature branch, esperá a CodeRabbit con polling:

```bash
PR_NUMBER=N  # El número del PR
SINCE=$(date -u +%s)  # Timestamp del push

# Trigger explícito de review (después de fixes; al primer push CodeRabbit lo hace automático)
# gh pr comment $PR_NUMBER --body "@coderabbitai review"

# Poll cada 30s hasta que aparezca nuevo comentario del bot
while true; do
  LAST_BOT_COMMENT=$(gh api "repos/lhpaul/helm/issues/$PR_NUMBER/comments" \
    --jq "[.[] | select(.user.login == \"coderabbitai[bot]\") | .created_at] | last")
  LAST_TS=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_BOT_COMMENT" +%s 2>/dev/null || echo 0)
  if [ "$LAST_TS" -gt "$SINCE" ]; then
    echo "CodeRabbit respondió. Leyendo comentarios..."
    gh pr view $PR_NUMBER --comments
    break
  fi
  sleep 30
done
```

Reglas del loop:

- Timeout máximo: 10 minutos. Si CodeRabbit no responde en 10 min, parar y pedir input humano (probablemente hit rate limit).
- Si el último comentario es "No actionable comments were generated" o equivalente, considerar el PR clean.
- Si hay actionable comments, evaluá cada uno: si cae en categoría auto-fixable (ver lista arriba), aplicar; si no, parar y pedir input humano.

### Categorías auto-fixables (lista viva)

Cuando CodeRabbit detecta uno de estos patrones, Claude Code puede aplicar el fix sin pedir input:

- **Path traversal**: input externo usado en filesystem path sin validación. Fix: validar con regex whitelist (`EXTERNAL_ID_REGEX` o equivalente) antes de construir el path.
- **Info leak en error responses**: paths absolutos, tokens, mensajes internos enviados al cliente. Fix: log server-side con `console.error`, devolver mensaje genérico al cliente.
- **Race condition en singleton lazy-init**: check-then-await sin single-flight pattern. Fix: shared in-flight promise + finally cleanup.
- **Race condition en create-if-not-exists**: read-then-write sin atomicidad. Fix: `writeFile(path, content, { flag: 'wx' })` o equivalente.
- **Validación laxa de body de API**: schemas Zod sin `.strict()`. Fix: agregar `.strict()` al schema.
- **Empty string en input externo**: el `??` (nullish coalescing) y los truthy checks (`if (value)`) no atrapan empty strings. Aplica a env vars, body fields de API, query params, headers, payloads de webhook. Fix: `?.trim()` + truthiness check explícito, o `typeof === 'string' && value.length > 0` cuando matters. Si downstream usa el valor para filesystem operations o lookups, no asumir que truthy === válido.
- **Mutable internal state returned by reference**: getter retorna array/object interno. Fix: spread copy `[...arr]` o `{...obj}` antes de retornar.
- **Never-throw contract violations**: cuando una interfaz/contrato dice "esta función nunca debe lanzar" (típicamente para handlers de webhooks, eventos, error-paths críticos), envolver implementaciones en try-catch defensivo. Aplica a parseWebhook de cualquier adapter, callbacks de error handlers, y métodos que se llamen desde paths donde no hay recovery posible.
- **Network operations without timeout / abort**: cualquier `fetch()`, `axios()`, request HTTP a sistema externo sin `AbortController` o timeout explícito puede colgar el proceso indefinidamente si el remote no responde. Fix: `AbortController` con timeout razonable (5-30s según el caso), `try/catch` que mapea errores de red a un tipo específico del dominio (e.g., `GitHubAPIError` con mensaje "request timeout"). Aplica a clientes HTTP custom, NO a clientes que ya manejan timeouts (Octokit con plugin de retry, fetch con `signal` configurado upstream).

Si CodeRabbit reporta algo que NO está en esta lista, parar y pedir input humano.
