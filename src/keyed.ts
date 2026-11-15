import type { Provider, ProviderId } from "./types.js";
import { Agent37Provider } from "./providers/agent37.js";
import { BoatProvider } from "./providers/boat.js";
import { DaytonaProvider } from "./providers/daytona.js";
import { E2BProvider } from "./providers/e2b.js";
import { FreestyleProvider } from "./providers/freestyle.js";
import { MaritimeProvider } from "./providers/maritime.js";
import { NovitaProvider } from "./providers/novita.js";
import { OpenScaleProvider } from "./providers/openscale.js";
import { SailProvider } from "./providers/sail.js";
import { SpritesProvider } from "./providers/sprites.js";
import { SuperserveProvider } from "./providers/superserve.js";
import { TensorlakeProvider } from "./providers/tensorlake.js";

/**
 * Providers whose adapter takes a single API key and sends only that key: given one here, nothing it
 * does reads a key from this process's environment. A service running sandboxes on its own accounts can
 * let a user bring their own key for these without ever charging the service's account for that user's
 * sandboxes (test/keyed.test.ts checks every request carries the key given). Base URLs still come from
 * the environment, as the operator set them; a user can't point the service at another host.
 */
const KEYED: Partial<Record<ProviderId, (key: string) => Provider>> = {
  agent37: (k) => new Agent37Provider(k),
  boat: (k) => new BoatProvider(k),
  daytona: (k) => new DaytonaProvider(k),
  e2b: (k) => new E2BProvider(k),
  freestyle: (k) => new FreestyleProvider(k),
  maritime: (k) => new MaritimeProvider(k),
  novita: (k) => new NovitaProvider(k),
  openscale: (k) => new OpenScaleProvider(k),
  sail: (k) => new SailProvider(k),
  sprites: (k) => new SpritesProvider(k),
  superserve: (k) => new SuperserveProvider(k),
  tensorlake: (k) => new TensorlakeProvider(k),
};

/** Ids `providerWithKey` takes. */
export const KEYED_PROVIDERS = Object.keys(KEYED) as ProviderId[];

/** An adapter for `id` that uses `key` and no key from the environment. Throws for other providers or an empty key. */
export function providerWithKey(id: ProviderId, key: string): Provider {
  const make = KEYED[id];
  if (!make) throw new Error(`${id} can't take a key this way; it takes: ${KEYED_PROVIDERS.join(", ")}`);
  if (typeof key !== "string" || !key.trim()) throw new Error(`the ${id} key is empty`);
  return make(key.trim());
}
