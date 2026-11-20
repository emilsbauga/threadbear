// Backfills this deploy is a stepping stone for (convex/migrations.ts).
// Always empty in the repo. When a release makes a field required that rows
// already stored may lack, runner/scripts/deploy-backend.mjs deploys that
// release once with this file listing the backfill's name: the field is
// optional then (schema.ts `stepping`) and its machine is off, so the deploy
// goes through whatever the rows hold. It runs the backfill, then deploys the
// release as it is. A fork deploys its own tree this way too, its own schema
// changes included, and a deployment that skipped releases needs nothing
// older than the one it's updating to.
//
// While a machine is off, its functions say the backend is being updated
// (unlessStepping): for the minute or so the backfill takes.
import { ConvexError, v, type Validator } from 'convex/values';

export const STEPPING: readonly string[] = [];

export const steppingFor = (name: string): boolean => STEPPING.includes(name);

/**
 * A field that's required, except while its backfill's stepping stone is
 * deployed. Typed as required: no code runs against the stone but the
 * backfill, which fills it.
 */
export function requiredUnlessStepping<V extends Validator<unknown, 'required', string>>(name: string, field: V): V {
  return (steppingFor(name) ? v.optional(field) : field) as unknown as V;
}

/** The machine, or while its backfill's stepping stone is deployed, a stand-in that refuses every use. */
export function unlessStepping<T extends object>(name: string, make: () => T): T {
  if (!steppingFor(name)) return make();
  return new Proxy({} as T, {
    get: () => {
      throw new ConvexError({ kind: 'conflict', message: 'The backend is being updated. Try again in a minute.' });
    },
  });
}
