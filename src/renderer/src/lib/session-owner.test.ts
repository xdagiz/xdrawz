import type { UnsavedChoice, UnsavedReason } from "@shared/ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DrawingSessionControls } from "@/lib/drawing-session";

import { createSessionOwner } from "./session-owner";

const makeSession = () => ({
  onChange: vi.fn(),
  saveNow: vi.fn(async () => true),
  flush: vi.fn(async () => {}),
  setAutosavePaused: vi.fn(),
  getSerializedContent: vi.fn(() => "{}"),
  setInitialBaseline: vi.fn(),
  resetBaseline: vi.fn(),
  ensureCleanOrConfirm: vi.fn(
    async (reason: UnsavedReason, confirm?: (r: UnsavedReason) => Promise<UnsavedChoice>) =>
      confirm ? (await confirm(reason)) !== "cancel" : true,
  ),
  isDirty: vi.fn(() => false),
  setAutosaveInterval: vi.fn(),
  dispose: vi.fn(),
});

type FakeSession = ReturnType<typeof makeSession>;

const asSession = (fake: FakeSession): DrawingSessionControls => fake;

const setup = () => {
  const confirmUnsaved = vi.fn(async (_reason: UnsavedReason): Promise<UnsavedChoice> => "save");
  return { owner: createSessionOwner({ confirmUnsaved }), confirmUnsaved };
};

describe("session-owner", () => {
  it("binds ensureCleanOrConfirm to the owner's dialog dependency", async () => {
    const { owner, confirmUnsaved } = setup();
    const raw = makeSession();
    const session = owner.acquire("f1", asSession(raw));

    await expect(session.ensureCleanOrConfirm("quit")).resolves.toBe(true);

    expect(raw.ensureCleanOrConfirm).toHaveBeenCalledTimes(1);
    expect(raw.ensureCleanOrConfirm).toHaveBeenCalledWith("quit", confirmUnsaved);
    expect(confirmUnsaved).toHaveBeenCalledWith("quit");
  });

  it("survives a mount, unmount, remount sequence with one live session", () => {
    const { owner } = setup();
    const first = makeSession();
    const second = makeSession();

    const s1 = owner.acquire("f1", asSession(first));
    owner.release("f1");
    const s2 = owner.acquire("f1", asSession(second));

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(s2).not.toBe(s1);
    expect(owner.getSession()).toBe(s2);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("disposes an incoming duplicate for the already-active fileId", () => {
    const { owner } = setup();
    const live = makeSession();
    const duplicate = makeSession();

    const bound = owner.acquire("f1", asSession(live));
    const returned = owner.acquire("f1", asSession(duplicate));

    expect(duplicate.dispose).toHaveBeenCalledTimes(1);
    expect(returned).toBe(bound);
    expect(live.dispose).not.toHaveBeenCalled();
  });

  it("releases exactly once and ignores stale fileIds", () => {
    const { owner } = setup();
    const session = makeSession();
    owner.acquire("f1", asSession(session));

    owner.release("other");
    expect(session.dispose).not.toHaveBeenCalled();
    expect(owner.getSession()).not.toBeNull();

    owner.release("f1");
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(owner.getSession()).toBeNull();

    owner.release("f1");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns null on fileId mismatch and the session without one", () => {
    const { owner } = setup();
    const session = owner.acquire("f1", asSession(makeSession()));

    expect(owner.getSession("f1")).toBe(session);
    expect(owner.getSession("f2")).toBeNull();
    expect(owner.getSession()).toBe(session);
  });

  it("clears the active session via setActiveForTest(null)", () => {
    const { owner } = setup();
    owner.acquire("f1", asSession(makeSession()));

    owner.setActiveForTest(null);

    expect(owner.getSession()).toBeNull();
  });
});
