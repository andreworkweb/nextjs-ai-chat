import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  createConversation,
  getConversationStorageKey,
  getOrCreateOwnerId,
  loadConversation,
  parseConversation,
  resetConversation,
  saveConversation,
} from "../app/lib/chat-context/storage.ts";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let storage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    writable: true,
    configurable: true,
  });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

function completeTurn(id = "turn-one", content = "Remember blue") {
  return {
    id,
    user: { id: `${id}:user`, role: "user", content },
    assistant: { id: `${id}:assistant`, role: "assistant", content: "Blue remembered" },
    status: "complete",
  };
}

function conversation(ownerId = "owner-one") {
  return { ...createConversation(ownerId), turns: [completeTurn()] };
}

test("browser identity is stable across reloads and separate across browser stores", () => {
  const owner = getOrCreateOwnerId();
  assert.equal(getOrCreateOwnerId(), owner);
  globalThis.window.localStorage = new MemoryStorage();
  assert.notEqual(getOrCreateOwnerId(), owner);
});

test("saved user and assistant messages restore without mutation or duplication", () => {
  const saved = conversation();
  saveConversation(saved);
  const restored = loadConversation(saved.ownerId);
  assert.deepEqual(restored, saved);
  assert.notEqual(restored, saved);
  assert.equal(restored.turns.length, 1);
  assert.deepEqual(loadConversation(saved.ownerId), saved);
});

test("history is scoped by owner and rejects a record belonging to another owner", () => {
  const first = conversation();
  const second = conversation("owner-two");
  second.turns[0].user.content = "Remember green";
  saveConversation(first);
  saveConversation(second);
  assert.deepEqual(loadConversation(first.ownerId), first);
  assert.deepEqual(loadConversation(second.ownerId), second);
  storage.setItem(getConversationStorageKey(first.ownerId), JSON.stringify(second));
  assert.throws(() => loadConversation(first.ownerId), /invalid/);
});

test("missing history restores as null and new conversations have distinct IDs", () => {
  assert.equal(loadConversation("owner-one"), null);
  assert.notEqual(createConversation("owner-one").id, createConversation("owner-one").id);
});

test("corrupt JSON and unsupported schemas remain untouched for explicit recovery", () => {
  const key = getConversationStorageKey("owner-one");
  for (const data of ["{broken", JSON.stringify({ ...conversation(), version: 2 })]) {
    storage.setItem(key, data);
    assert.throws(() => loadConversation("owner-one"), /invalid/);
    assert.equal(storage.getItem(key), data);
  }
});

test("duplicate message identity is rejected but intentional repeated content is valid", () => {
  const saved = conversation();
  saved.turns.push(completeTurn("turn-two"));
  assert.equal(parseConversation(saved, saved.ownerId).turns.length, 2);
  saved.turns.push(completeTurn());
  assert.throws(() => parseConversation(saved, saved.ownerId), /invalid/);
});

test("storage rejects inconsistent roles, IDs, turn completion, and pending ordering", () => {
  const variants = [
    (value) => { value.turns[0].user.role = "system"; },
    (value) => { value.turns[0].user.id = "unrelated-message"; },
    (value) => { value.turns[0].assistant.content = " "; },
    (value) => { delete value.turns[0].assistant; },
    (value) => { value.turns[0].status = "pending"; },
    (value) => {
      delete value.turns[0].assistant;
      value.turns[0].status = "pending";
      value.turns.push(completeTurn("turn-two"));
    },
  ];
  for (const corrupt of variants) {
    const saved = conversation();
    corrupt(saved);
    assert.throws(() => parseConversation(saved, saved.ownerId), /invalid/);
  }
});

test("pending and failed turns retain their user message for recovery", () => {
  for (const status of ["pending", "failed", "interrupted"]) {
    const saved = conversation();
    delete saved.turns[0].assistant;
    saved.turns[0].status = status;
    saveConversation(saved);
    assert.deepEqual(loadConversation(saved.ownerId), saved);
  }
});

test("storage failure reports a safe error and leaves previous history intact", () => {
  const saved = conversation();
  saveConversation(saved);
  const previous = storage.getItem(getConversationStorageKey(saved.ownerId));
  storage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  assert.throws(() => saveConversation(createConversation(saved.ownerId)), /could not be saved/);
  assert.equal(storage.getItem(getConversationStorageKey(saved.ownerId)), previous);
});

test("unavailable storage does not throw until an operation needs it", () => {
  Object.defineProperty(globalThis.window, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  assert.throws(() => getOrCreateOwnerId(), /cannot be read/);
  assert.throws(() => loadConversation("owner-one"), /cannot be read/);
  assert.throws(() => saveConversation(conversation()), /could not be saved/);
});

test("an explicit clear rotates the conversation and anchors a fallback owner identity", () => {
  const initialOwner = getOrCreateOwnerId();
  const ownerKey = [...storage.values.keys()].find((key) => !key.includes("conversation"));
  const previous = conversation(initialOwner);
  saveConversation(previous);
  storage.setItem(ownerKey, "invalid owner identity!");
  assert.throws(() => getOrCreateOwnerId(), /invalid/);

  const cleared = resetConversation(initialOwner);
  assert.equal(getOrCreateOwnerId(), initialOwner);
  assert.notEqual(cleared.id, previous.id);
  assert.deepEqual(cleared.turns, []);
  assert.deepEqual(loadConversation(initialOwner), cleared);
});
