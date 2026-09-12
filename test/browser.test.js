import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyNetworkModelSlug,
  classifyProbeModel,
  classifyRateLimitText,
  ChatGPTBrowser,
  composerEditReason,
  generationIsStale,
  interruptedGenerationFields,
  isProModel,
  isProTier,
  networkRateLimitScope,
  normalizeModelSlug,
  parseAdvancedRowValue,
  parseAnswerTier,
  promptWriteAction,
  rankTextMatch,
  redactDiagnosticPath,
  siteActionDelayMs,
  siteActionWaitMs,
  validProbeCache,
} from "../src/browser.js";
import { chromeExecutableCandidates, PROBE_POLICY_KEY } from "../src/config.js";

test("rankTextMatch prefers exact and unique model names", () => {
  const options = [
    { name: "GPT-5.6" },
    { name: "GPT-5.6 Pro" },
    { name: "GPT-5.5" },
  ];
  const matches = rankTextMatch(options, "GPT-5.6", (item) => item.name);
  assert.equal(matches[0].item.name, "GPT-5.6");
  assert.equal(matches[0].score, 100);
});

test("rankTextMatch handles Chinese history titles", () => {
  const conversations = [
    { title: "前端登录问题排查" },
    { title: "登录问题" },
    { title: "数据分析" },
  ];
  const matches = rankTextMatch(conversations, "登录问题", (item) => item.title);
  assert.equal(matches[0].item.title, "登录问题");
});

test("parseAdvancedRowValue extracts model and thinking values", () => {
  assert.equal(parseAdvancedRowValue("模型 GPT-5.6 Sol ›", ["模型", "Model"]), "GPT-5.6 Sol");
  assert.equal(
    parseAdvancedRowValue("思考强度 极高 ›", ["思考强度", "Thinking effort"]),
    "极高",
  );
});

test("isProModel only enables unlimited waits for a Pro model token", () => {
  assert.equal(isProModel("GPT-5.6 Pro"), true);
  assert.equal(isProModel("Pro"), true);
  assert.equal(isProModel("GPT-5.6 Sol"), false);
  assert.equal(isProModel("Professional preview"), false);
  assert.equal(isProTier("Pro"), true);
});

test("parseAnswerTier extracts the semantic tier from slider text", () => {
  assert.equal(parseAnswerTier("极高，第 4 项，共 5 项。 使用左右箭头键调整能力。"), "极高");
  assert.equal(parseAnswerTier("Pro, 5 of 5"), "Pro");
});

test("promptWriteAction never replaces a different user draft", () => {
  assert.equal(promptWriteAction("", "new prompt"), "replace-empty");
  assert.equal(promptWriteAction("new prompt", "new prompt"), "already-present");
  assert.equal(promptWriteAction("user draft", "tool prompt"), "reject-nonempty");
  assert.equal(promptWriteAction("user draft", "tool prompt", { append: true }), "append");
});

test("composerEditReason protects a user turn in edit mode", () => {
  assert.equal(composerEditReason({ insideUserMessage: true }), "composer-inside-user-message");
  assert.equal(composerEditReason({ visibleCancel: true }), "visible-edit-cancel-control");
  assert.equal(composerEditReason(), null);
});

test("classifyProbeModel only accepts the two explicit routing identities", () => {
  assert.equal(classifyProbeModel("我是 GPT-5.6 Pro。"), "gpt-5.6-pro");
  assert.equal(classifyProbeModel("当前是 GPT 5.5 mini"), "gpt-5.5-mini");
  assert.equal(classifyProbeModel("我是 GPT-5.6"), "unknown");
  assert.equal(classifyProbeModel("我无法查看底层模型"), "unknown");
  assert.equal(
    classifyProbeModel("Acme Ultra", {
      acceptPattern: "acme\\s+ultra",
      fallbackPattern: "acme\\s+mini",
      acceptClassification: "accepted",
      fallbackClassification: "fallback",
    }),
    "accepted",
  );
});

test("network model_slug is authoritative for identity verification", () => {
  assert.equal(normalizeModelSlug("GPT_5.6-thinking"), "gpt-5-6-thinking");
  assert.equal(classifyNetworkModelSlug("gpt-5-5-mini"), "gpt-5.5-mini");
  assert.equal(classifyNetworkModelSlug("gpt-5-6-thinking"), "network-verified");
  assert.equal(
    classifyProbeModel("我是 GPT-5.6 Sol。", {
      networkModelSlug: "gpt-5-6-thinking",
      requireNetworkModelSlug: true,
    }),
    "network-verified",
  );
  assert.equal(
    classifyProbeModel("我是 GPT-5.6 Sol。", {
      networkModelSlug: "gpt-5-5-mini",
      requireNetworkModelSlug: true,
    }),
    "gpt-5.5-mini",
  );
  assert.equal(
    classifyProbeModel("我是 GPT-5.6 Pro。", { requireNetworkModelSlug: true }),
    "unknown",
  );
});

test("chromeExecutableCandidates supports explicit and platform-specific paths", () => {
  assert.deepEqual(
    chromeExecutableCandidates({
      platform: "linux",
      env: { CHATGPT_WEB_CHROME: "/opt/custom/chrome" },
      home: "/home/test",
    }),
    ["/opt/custom/chrome"],
  );
  const windows = chromeExecutableCandidates({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    home: "C:\\Users\\test",
  });
  assert.ok(windows.some((candidate) => candidate.endsWith("Google/Chrome/Application/chrome.exe")));
});

test("classifyRateLimitText separates history and generation limits", () => {
  assert.deepEqual(
    classifyRateLimitText(
      "请求过于频繁。为保障数据安全，我们已暂时限制你访问对话记录。请稍等几分钟后再重试。",
    ),
    { limited: true, scope: "history" },
  );
  assert.deepEqual(
    classifyRateLimitText("Too many requests while generating a response. Please wait and try again."),
    { limited: true, scope: "generation" },
  );
  assert.deepEqual(classifyRateLimitText("正常页面"), { limited: false, scope: null });
});

test("siteActionDelayMs enforces the configured start interval", () => {
  assert.equal(siteActionDelayMs(10_000, 12_000, 5_000), 3_000);
  assert.equal(siteActionDelayMs(10_000, 16_000, 5_000), 0);
  assert.equal(siteActionDelayMs(null, 16_000, 5_000), 0);
});

test("validProbeCache stays valid for the same open browser page session", () => {
  const cache = {
    classification: "network-verified",
    modelSlug: "gpt-5-6-thinking",
    modelSlugSource: "conversation-response",
    policyKey: PROBE_POLICY_KEY,
    mode: "聊天",
    checkedAt: 5_000,
    expiresAt: 6_000,
    browserSessionId: "browser-a",
    chatgptPageId: "page-a",
  };
  const session = {
    browserRunning: true,
    browserStartedAt: 1_000,
    browserSessionId: "browser-a",
    chatgptPageOpen: true,
    chatgptPageId: "page-a",
  };
  const cached = validProbeCache(cache, {
    mode: "聊天",
    session,
    now: 1_000_000,
  });
  assert.equal(cached.classification, cache.classification);
  assert.equal(cached.expiresAt, null);
  assert.equal(validProbeCache(cache, { mode: "工作", session }), null);
  assert.equal(
    validProbeCache({ ...cache, policyKey: "different-policy" }, { mode: "聊天", session }),
    null,
  );
  assert.equal(
    validProbeCache(
      { ...cache, classification: "unknown" },
      { mode: "聊天", session },
    ),
    null,
  );
  assert.equal(
    validProbeCache(
      { ...cache, modelSlug: null, modelSlugSource: null },
      { mode: "聊天", session },
    ),
    null,
  );
});

test("validProbeCache waits three hours after a page or browser interruption", () => {
  const cache = {
    classification: "network-verified",
    modelSlug: "gpt-5-6-thinking",
    modelSlugSource: "conversation-response",
    policyKey: PROBE_POLICY_KEY,
    mode: "聊天",
    checkedAt: 5_000,
    browserSessionId: "browser-a",
    chatgptPageId: "page-a",
  };
  const interrupted = validProbeCache(cache, {
    mode: "聊天",
    session: { browserRunning: false, chatgptPageOpen: false },
    now: 10_000,
    recheckAfterCloseMs: 30_000,
  });
  assert.equal(interrupted.sessionInterruptedAt, 10_000);
  assert.equal(interrupted.recheckAfter, 40_000);
  assert.equal(
    validProbeCache(interrupted, {
      mode: "聊天",
      session: { browserRunning: false, chatgptPageOpen: false },
      now: 39_999,
      recheckAfterCloseMs: 30_000,
    }),
    interrupted,
  );
  assert.equal(
    validProbeCache(interrupted, {
      mode: "聊天",
      session: { browserRunning: false, chatgptPageOpen: false },
      now: 40_000,
      recheckAfterCloseMs: 30_000,
    }),
    null,
  );

  const replacedPage = validProbeCache(cache, {
    mode: "聊天",
    session: {
      browserRunning: true,
      browserStartedAt: 1_000,
      browserSessionId: "browser-a",
      chatgptPageOpen: true,
      chatgptPageId: "page-b",
    },
    now: 20_000,
    recheckAfterCloseMs: 30_000,
  });
  assert.equal(replacedPage.sessionInterruptedAt, 20_000);
  assert.equal(replacedPage.recheckAfter, 50_000);
});

test("validProbeCache migrates a legacy cache when its original browser is still open", () => {
  const cache = {
    classification: "network-verified",
    modelSlug: "gpt-5-6-thinking",
    modelSlugSource: "conversation-response",
    policyKey: PROBE_POLICY_KEY,
    mode: "聊天",
    checkedAt: 5_000,
    expiresAt: 6_000,
  };
  const migrated = validProbeCache(cache, {
    mode: "聊天",
    session: {
      browserRunning: true,
      browserStartedAt: 1_000,
      browserSessionId: "browser-a",
      chatgptPageOpen: true,
      chatgptPageId: "page-a",
    },
    now: 1_000_000,
  });
  assert.equal(migrated.browserSessionId, "browser-a");
  assert.equal(migrated.chatgptPageId, "page-a");
  assert.equal(migrated.expiresAt, null);
});

test("redactDiagnosticPath removes conversation and opaque identifiers", () => {
  assert.equal(
    redactDiagnosticPath("/backend-api/conversation/123e4567-e89b-12d3-a456-426614174000"),
    "/backend-api/conversation/:id",
  );
  assert.equal(
    redactDiagnosticPath("/c/123e4567-e89b-12d3-a456-426614174000"),
    "/c/:id",
  );
  assert.equal(redactDiagnosticPath("/backend-api/models"), "/backend-api/models");
});

test("networkRateLimitScope identifies history list rate limits", () => {
  assert.equal(networkRateLimitScope("/backend-api/conversations"), "history");
  assert.equal(networkRateLimitScope("/backend-api/conversations/"), "history");
  assert.equal(networkRateLimitScope("/backend-api/conversation/:id"), "generation");
  assert.equal(networkRateLimitScope("/backend-api/models"), "http-429");
});

test("siteActionWaitMs enforces the 30 second send interval", () => {
  assert.equal(
    siteActionWaitMs(
      { lastSiteActionAt: 90_000, lastPageInteractionAt: 99_500, lastSendAt: 80_000 },
      "send-prompt",
      100_000,
      { siteActionIntervalMs: 5_000, sendIntervalMs: 30_000, postBreakerCooldownMs: 60_000 },
    ),
    10_000,
  );
});

test("siteActionWaitMs gives post-breaker cooldown highest priority", () => {
  assert.equal(
    siteActionWaitMs(
      {
        lastSiteActionAt: 90_000,
        lastSendAt: 60_000,
        circuitBreakerClearedAt: 80_000,
        postBreakerCooldownPending: true,
      },
      "new-chat",
      100_000,
      { siteActionIntervalMs: 5_000, sendIntervalMs: 30_000, postBreakerCooldownMs: 60_000 },
    ),
    40_000,
  );
});

test("siteActionWaitMs waits after a completed answer before changing conversations", () => {
  assert.equal(
    siteActionWaitMs(
      {
        lastSiteActionAt: 90_000,
        lastConversationChangeAt: 70_000,
        lastGenerationCompletedAt: 90_000,
      },
      "new-chat",
      100_000,
      {
        siteActionIntervalMs: 5_000,
        conversationChangeIntervalMs: 30_000,
        postResponseConversationCooldownMs: 30_000,
        postBreakerCooldownMs: 300_000,
      },
    ),
    20_000,
  );
});

test("siteActionWaitMs honors an absolute history quiet deadline", () => {
  assert.equal(
    siteActionWaitMs(
      { lastSiteActionAt: 90_000, historyQuietUntil: 240_000 },
      "select-history",
      100_000,
      {
        siteActionIntervalMs: 5_000,
        conversationChangeIntervalMs: 30_000,
        postResponseConversationCooldownMs: 30_000,
        postBreakerCooldownMs: 300_000,
      },
    ),
    140_000,
  );
});

test("closing the browser releases an interrupted generation lock", () => {
  assert.deepEqual(
    interruptedGenerationFields(
      { activeGeneration: { active: true, status: "waiting" } },
      123_456,
    ),
    {
      activeGeneration: null,
      lastGenerationInterruptedAt: 123_456,
    },
  );
  assert.deepEqual(interruptedGenerationFields({}, 123_456), {
    activeGeneration: null,
  });
});

test("dead generation owners are stale but the current process is not", () => {
  assert.equal(
    generationIsStale({ activeGeneration: { active: true, ownerPid: 2_147_483_647 } }),
    true,
  );
  assert.equal(
    generationIsStale({ activeGeneration: { active: true, ownerPid: process.pid } }),
    false,
  );
  assert.equal(generationIsStale({ activeGeneration: { active: true } }), false);
});

test("refreshBeforeSend reloads the selected conversation before sending", async () => {
  const browser = new ChatGPTBrowser();
  let reloads = 0;
  const page = {
    url: () => "https://chatgpt.com/c/conversation-a",
    reload: async () => {
      reloads += 1;
    },
    waitForTimeout: async () => {},
    locator: () => ({ evaluateAll: async () => 0 }),
  };
  browser.page = async () => page;
  browser.ensureSignedIn = async () => {};
  browser.composer = async () => ({ });
  browser.assertComposerWritable = async () => {};
  browser.composerText = async () => "";
  browser.webSearchState = async () => ({ selected: false, label: null });
  browser.pageInteraction = async () => {};

  const result = await browser.refreshBeforeSend({ reason: "test" });
  assert.equal(reloads, 1);
  assert.equal(result.refreshed, true);
  assert.equal(result.conversationId, "conversation-a");
});

test("refreshBeforeSend restores a draft only when refresh cleared it", async () => {
  const browser = new ChatGPTBrowser();
  let readCount = 0;
  let restored = null;
  const page = {
    url: () => "https://chatgpt.com/c/conversation-a",
    reload: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ evaluateAll: async () => 0 }),
  };
  browser.page = async () => page;
  browser.ensureSignedIn = async () => {};
  browser.composer = async () => ({ });
  browser.assertComposerWritable = async () => {};
  browser.composerText = async () => (readCount++ === 0 ? "draft" : "");
  browser.webSearchState = async () => ({ selected: false, label: null });
  browser.pageInteraction = async () => {};
  browser.fill = async (_composer, value) => {
    restored = value;
  };

  const result = await browser.refreshBeforeSend({ reason: "test" });
  assert.equal(restored, "draft");
  assert.equal(result.draftRestored, true);
});
