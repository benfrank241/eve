import { defineChannel } from "#public/channels/index.js";

// Epoch 37 channels had no schedule destination capture; it is additive.
export default defineChannel({
  routes: [],
  events: {
    "authorization.required"(event) {
      console.info("sign-in required", { name: event.name, principalId: event.principalId });
    },
  },
});
