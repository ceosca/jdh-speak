import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./chat-util.js";

describe("RateLimiter", () => {
  it("allows up to the limit within the window", () => {
    const rl = new RateLimiter(5, 10_000);
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.tryConsume("a", 1000 + i), true, `send ${i} should pass`);
    }
    // 6th within the window is blocked.
    assert.equal(rl.tryConsume("a", 1100), false);
  });

  it("blocked attempts do not consume budget — sender recovers after the window", () => {
    const rl = new RateLimiter(5, 10_000);
    for (let i = 0; i < 5; i++) rl.tryConsume("a", 1000);
    // Hammering while blocked stays blocked but mustn't push the window forward.
    assert.equal(rl.tryConsume("a", 2000), false);
    assert.equal(rl.tryConsume("a", 5000), false);
    // Once 10s have elapsed since the 5 accepted sends, sending works again.
    assert.equal(rl.tryConsume("a", 11_001), true);
  });

  it("slides: an old send leaving the window frees a slot", () => {
    const rl = new RateLimiter(5, 10_000);
    rl.tryConsume("a", 0); // this one expires at t=10_000
    for (let i = 1; i < 5; i++) rl.tryConsume("a", 1000);
    assert.equal(rl.tryConsume("a", 1000), false); // 5 in window
    assert.equal(rl.tryConsume("a", 10_001), true); // first one aged out
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(5, 10_000);
    for (let i = 0; i < 5; i++) rl.tryConsume("a", 1000);
    assert.equal(rl.tryConsume("a", 1000), false);
    assert.equal(rl.tryConsume("b", 1000), true); // different sender unaffected
  });

  it("forget() resets a key", () => {
    const rl = new RateLimiter(5, 10_000);
    for (let i = 0; i < 5; i++) rl.tryConsume("a", 1000);
    assert.equal(rl.tryConsume("a", 1000), false);
    rl.forget("a");
    assert.equal(rl.tryConsume("a", 1000), true);
  });
});
