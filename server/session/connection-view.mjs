import { AsyncLocalStorage } from 'node:async_hooks';

const delivery = new AsyncLocalStorage();

// Native receipt handlers can outlive the command and the transport that started it.
export function bindConnectionDelivery(action) {
  const scope = delivery.getStore();
  return (...args) => delivery.run(scope, () => action(...args));
}

export class ConnectionView {
  #current;

  constructor(client, visible = true) {
    this.visible = this.notifyVisible = visible;
    this.notifyPresenceAt = Date.now();
    this.connect(client);
  }

  get client() { return this.#current.client; }
  get generation() { return this.#current; }

  connect(client, authorized = () => true) {
    this.#current = { view: this, client, authorized, active: true };
  }

  retire() { this.#current.active = false; }

  current(scope = this.#current) {
    return scope === this.#current && scope.active && scope.authorized() && scope.client.readyState === 1;
  }

  run(action, scope = this.#current) { return delivery.run(scope, action); }

  matchesDelivery() {
    const scope = delivery.getStore();
    return !scope || scope.view !== this || scope === this.#current;
  }

  acceptsDelivery() {
    return this.matchesDelivery() && this.#current.active && this.#current.authorized();
  }

  // Registry and library broadcasts check this lease even if the network close is delayed.
  recipient() {
    const scope = this.#current, view = this;
    return {
      get readyState() { return view.current(scope) ? 1 : 3; },
      send(packet) { if (view.current(scope)) scope.client.send(packet); },
      once(event, handler) { scope.client.once(event, handler); },
    };
  }
}
