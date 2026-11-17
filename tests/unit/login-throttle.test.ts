import { beforeEach, describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";
import { isThrottled, registerFailure, resetThrottle } from "../../src/services/login-throttle.js";

const MINUTE = 60_000;

beforeEach(resetThrottle);

describe("login-throttle", () => {
  it("bloque au bout de LOGIN_MAX_ATTEMPTS échecs et se débloque à l'expiration", () => {
    const t0 = 1_000_000;
    for (let i = 1; i < env.LOGIN_MAX_ATTEMPTS; i++) {
      expect(registerFailure("a@x.fr", "1.1.1.1", t0)).toBe(false);
    }
    expect(registerFailure("a@x.fr", "1.1.1.1", t0)).toBe(true);
    expect(isThrottled("a@x.fr", "1.1.1.1", t0 + 1)).toBe(true);
    expect(isThrottled("a@x.fr", "1.1.1.1", t0 + env.LOGIN_LOCK_MINUTES * MINUTE + 1)).toBe(false);
  });

  it("compte séparément chaque adresse IP", () => {
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) registerFailure("a@x.fr", "1.1.1.1", 0);
    expect(isThrottled("a@x.fr", "1.1.1.1", 1)).toBe(true);
    expect(isThrottled("a@x.fr", "2.2.2.2", 1)).toBe(false);
  });

  it("oublie les échecs trop anciens", () => {
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS - 1; i++) registerFailure("a@x.fr", "1.1.1.1", 0);
    expect(registerFailure("a@x.fr", "1.1.1.1", env.LOGIN_LOCK_MINUTES * MINUTE + 10)).toBe(false);
  });
});
