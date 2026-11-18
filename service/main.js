// service/main.ts
import http from "node:http";
var COOLDOWN_MS = 2000;
var VELOCITY_WINDOW_SECONDS = 30;
var MAX_SESSIONS = 200;
var createTrackerStore = (onUnknownSession) => ({
  sessions: new Map,
  selectedSessionByDirectory: new Map,
  sseConnected: false,
  lastEventAt: null,
  onUnknownSession
});
var isRecord = (val) => Boolean(val) && typeof val === "object" && !Array.isArray(val);
var trimmed = (val) => typeof val === "string" ? val.trim() : "";
var normalizeDirectory = (dir) => {
  if (!dir)
    return null;
  const clean = dir.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return clean || null;
};
var emptyDurations = () => ({
  ttft: 0,
  reasoning: 0,
  toolInput: 0,
  toolExec: 0,
  text: 0,
  blocked: 0,
  finalize: 0
});
var ensureSession = (store, sessionId, now = Date.now()) => {
  const existing = store.sessions.get(sessionId);
  if (existing)
    return existing;
  if (store.sessions.size >= MAX_SESSIONS) {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, s] of store.sessions.entries()) {
      if (!s.busy && s.lastUpdatedAt < oldestTime) {
        oldestTime = s.lastUpdatedAt;
        oldestId = id;
      }
    }
    if (oldestId)
      store.sessions.delete(oldestId);
  }
  const created = {
    sessionId,
    parentId: null,
    directory: null,
    title: null,
    agent: null,
    modelLabel: null,
    hydrated: false,
    hydrating: false,
    busy: false,
    phase: "idle",
    phaseEnteredAt: now,
    turnStartedAt: null,
    turnEndedAt: null,
    stepStartedAt: null,
    stepFirstTokenAt: null,
    firstTokenAt: null,
    stepEnded: false,
    lastStreamKind: null,
    initialTtftMs: null,
    lastStepTtftMs: null,
    stepCount: 0,
    activeReasoningOrdinals: new Set,
    activeTextOrdinals: new Set,
    activeTools: new Map,
    completedTools: 0,
    failedTools: 0,
    compacting: false,
    pendingPermissions: new Map,
    pendingForms: new Map,
    retry: null,
    lastError: null,
    durationsMs: emptyDurations(),
    lastAccountingAt: null,
    reasoningChars: 0,
    textChars: 0,
    toolInputChars: 0,
    stepStreamedChars: 0,
    completedOutputTokens: 0,
    totalCost: null,
    velocityBySecond: new Map,
    peakTokPerSec: 0,
    lastUpdatedAt: now
  };
  store.sessions.set(sessionId, created);
  return created;
};
var phaseToBucket = (phase) => {
  switch (phase) {
    case "waiting-first-token":
      return "ttft";
    case "reasoning":
      return "reasoning";
    case "tool-input":
      return "toolInput";
    case "tool-running":
    case "compacting":
      return "toolExec";
    case "streaming-text":
      return "text";
    case "waiting-permission":
    case "waiting-question":
    case "retrying":
    case "subagent-wait":
      return "blocked";
    case "finalizing":
      return "finalize";
    default:
      return null;
  }
};
var accruePhaseDuration = (session, now) => {
  const isTracking = session.busy || session.phase === "subagent-wait";
  if (session.lastAccountingAt === null) {
    if (isTracking)
      session.lastAccountingAt = now;
    return;
  }
  const delta = Math.max(0, now - session.lastAccountingAt);
  const bucket = phaseToBucket(session.phase);
  if (bucket && delta > 0 && delta < 300000) {
    session.durationsMs[bucket] += delta;
  }
  session.lastAccountingAt = isTracking ? now : null;
};
var activeChildSubagentsOf = (store, sessionId) => {
  const result = [];
  for (const candidate of store.sessions.values()) {
    if (candidate.parentId === sessionId && candidate.busy) {
      result.push(candidate);
    }
  }
  return result;
};
var derivePhase = (store, session, now) => {
  if (session.pendingPermissions.size > 0)
    return "waiting-permission";
  if (session.pendingForms.size > 0)
    return "waiting-question";
  if (session.retry !== null && session.busy)
    return "retrying";
  if (session.compacting && session.busy)
    return "compacting";
  if (session.busy) {
    let hasRunningTool = false;
    let hasInputTool = false;
    for (const tool of session.activeTools.values()) {
      if (tool.status === "running")
        hasRunningTool = true;
      else if (tool.status === "input")
        hasInputTool = true;
    }
    if (hasRunningTool)
      return "tool-running";
    if (hasInputTool)
      return "tool-input";
    if (session.activeReasoningOrdinals.size > 0)
      return "reasoning";
    if (session.activeTextOrdinals.size > 0)
      return "streaming-text";
    if (session.stepFirstTokenAt === null) {
      return "waiting-first-token";
    }
    if (!session.stepEnded && session.lastStreamKind === "reasoning") {
      return "reasoning";
    }
    return "finalizing";
  }
  if (activeChildSubagentsOf(store, session.sessionId).length > 0) {
    return "subagent-wait";
  }
  if (session.lastError)
    return "failed";
  if (session.turnEndedAt !== null && now - session.turnEndedAt < COOLDOWN_MS) {
    return "cooldown";
  }
  return "idle";
};
var updateSessionPhase = (store, session, now) => {
  accruePhaseDuration(session, now);
  const nextPhase = derivePhase(store, session, now);
  if (nextPhase !== session.phase) {
    session.phase = nextPhase;
    session.phaseEnteredAt = now;
  }
  session.lastAccountingAt = session.busy || nextPhase === "subagent-wait" ? now : null;
};
var recordFirstToken = (session, now) => {
  if (session.turnStartedAt !== null && session.firstTokenAt === null) {
    session.firstTokenAt = now;
    session.initialTtftMs = Math.max(0, now - session.turnStartedAt);
  }
  if (session.stepStartedAt !== null && session.stepFirstTokenAt === null) {
    session.stepFirstTokenAt = now;
    session.lastStepTtftMs = Math.max(0, now - session.stepStartedAt);
  } else if (session.stepFirstTokenAt === null) {
    session.stepFirstTokenAt = now;
  }
};
var recordStreamVelocity = (session, chars, now) => {
  if (chars <= 0)
    return;
  session.stepStreamedChars += chars;
  const sec = Math.floor(now / 1000);
  const nextChars = (session.velocityBySecond.get(sec) ?? 0) + chars;
  session.velocityBySecond.set(sec, nextChars);
  const estTokPerSec = Math.round(nextChars / 4);
  if (estTokPerSec > session.peakTokPerSec) {
    session.peakTokPerSec = estTokPerSec;
  }
  const cutoff = sec - VELOCITY_WINDOW_SECONDS - 5;
  for (const key of session.velocityBySecond.keys()) {
    if (key < cutoff)
      session.velocityBySecond.delete(key);
  }
};
var resetTurnMetrics = (session, now) => {
  session.turnStartedAt = now;
  session.turnEndedAt = null;
  session.stepStartedAt = now;
  session.stepFirstTokenAt = null;
  session.firstTokenAt = null;
  session.stepEnded = false;
  session.lastStreamKind = null;
  session.initialTtftMs = null;
  session.lastStepTtftMs = null;
  session.stepCount = 0;
  session.activeReasoningOrdinals.clear();
  session.activeTextOrdinals.clear();
  session.activeTools.clear();
  session.completedTools = 0;
  session.failedTools = 0;
  session.compacting = false;
  session.retry = null;
  session.lastError = null;
  session.durationsMs = emptyDurations();
  session.lastAccountingAt = now;
  session.reasoningChars = 0;
  session.textChars = 0;
  session.toolInputChars = 0;
  session.stepStreamedChars = 0;
  session.completedOutputTokens = 0;
  session.totalCost = null;
  session.velocityBySecond.clear();
  session.peakTokPerSec = 0;
};
var extractToolDetail = (name, input, metadata) => {
  if (isRecord(metadata)) {
    const innerTool = trimmed(metadata.tool) || trimmed(metadata.lastTool) || trimmed(metadata.activeTool);
    if (innerTool)
      return innerTool.slice(0, 24);
  }
  if (!isRecord(input))
    return;
  const pathVal = trimmed(input.path) || trimmed(input.filePath);
  if (pathVal) {
    const base = pathVal.split("/").filter(Boolean).pop() || pathVal;
    return base.slice(0, 24);
  }
  const cmd = trimmed(input.command);
  if (cmd)
    return cmd.split(/\s+/)[0]?.slice(0, 20);
  const pattern = trimmed(input.pattern) || trimmed(input.query);
  if (pattern)
    return pattern.slice(0, 20);
  const desc = trimmed(input.description);
  if (desc)
    return desc.slice(0, 24);
  if (name === "openchamber" && trimmed(input.action))
    return trimmed(input.action).slice(0, 24);
  return;
};
var applyWireEvent = (store, payload, now = Date.now()) => {
  if (!isRecord(payload))
    return;
  const type = trimmed(payload.type);
  if (!type)
    return;
  const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : {};
  const location = isRecord(payload.location) ? payload.location : {};
  const eventDir = normalizeDirectory(trimmed(location.directory) || trimmed(data.directory));
  const formObj = isRecord(data.form) ? data.form : null;
  const sessionId = trimmed(data.sessionID) || (formObj ? trimmed(formObj.sessionID) : "") || (isRecord(data.info) ? trimmed(data.info.sessionID) || trimmed(data.info.id) : "");
  store.lastEventAt = now;
  if (!sessionId)
    return;
  const session = ensureSession(store, sessionId, now);
  session.lastUpdatedAt = now;
  if (eventDir)
    session.directory = eventDir;
  if (!session.hydrated && !session.hydrating && type !== "session.created" && type !== "session.deleted") {
    store.onUnknownSession?.(sessionId);
  }
  switch (type) {
    case "session.created":
    case "session.updated":
    case "session.renamed":
    case "session.moved": {
      const info = isRecord(data.info) ? data.info : data;
      const parentID = trimmed(info.parentID);
      if (parentID)
        session.parentId = parentID;
      const dir = normalizeDirectory(trimmed(info.directory) || (isRecord(info.location) ? trimmed(info.location.directory) : ""));
      if (dir)
        session.directory = dir;
      if (typeof info.title === "string") {
        const cleanTitle = info.title.trim();
        if (cleanTitle)
          session.title = cleanTitle;
      }
      const agent = trimmed(info.agent);
      if (agent)
        session.agent = agent;
      if (type === "session.created")
        session.hydrated = true;
      break;
    }
    case "session.execution.started": {
      resetTurnMetrics(session, now);
      session.busy = true;
      break;
    }
    case "session.status": {
      const st = isRecord(data.status) ? data.status : {};
      const stType = trimmed(st.type);
      if (stType === "busy") {
        if (!session.busy) {
          resetTurnMetrics(session, now);
          session.busy = true;
        }
      } else if (stType === "retry") {
        session.busy = true;
        session.retry = {
          attempt: typeof st.attempt === "number" ? st.attempt : 1,
          nextAt: typeof st.next === "number" ? st.next : undefined,
          message: trimmed(st.message) || undefined
        };
      } else if (stType === "idle") {
        session.busy = false;
        session.turnEndedAt = now;
        session.activeReasoningOrdinals.clear();
        session.activeTextOrdinals.clear();
        session.activeTools.clear();
        session.compacting = false;
        session.retry = null;
      }
      break;
    }
    case "session.step.started": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      session.stepCount += 1;
      session.stepStartedAt = now;
      session.stepFirstTokenAt = null;
      session.stepEnded = false;
      session.lastStreamKind = null;
      session.stepStreamedChars = 0;
      session.retry = null;
      const agent = trimmed(data.agent);
      if (agent)
        session.agent = agent;
      const model = isRecord(data.model) ? data.model : {};
      const providerID = trimmed(model.providerID);
      const modelID = trimmed(model.id);
      if (modelID) {
        session.modelLabel = providerID ? `${providerID}/${modelID}` : modelID;
      }
      break;
    }
    case "session.step.streamed": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      break;
    }
    case "session.step.ended": {
      session.activeReasoningOrdinals.clear();
      session.activeTextOrdinals.clear();
      session.stepEnded = true;
      session.stepStreamedChars = 0;
      session.retry = null;
      if (typeof data.cost === "number") {
        session.totalCost = (session.totalCost ?? 0) + data.cost;
      }
      if (isRecord(data.tokens)) {
        const outputTok = typeof data.tokens.output === "number" ? data.tokens.output : 0;
        const reasoningTok = typeof data.tokens.reasoning === "number" ? data.tokens.reasoning : 0;
        session.completedOutputTokens += outputTok + reasoningTok;
      }
      break;
    }
    case "session.step.failed": {
      session.activeReasoningOrdinals.clear();
      session.activeTextOrdinals.clear();
      session.stepEnded = true;
      const err = isRecord(data.error) ? trimmed(data.error.message) : trimmed(data.error);
      if (err)
        session.lastError = err;
      break;
    }
    case "session.retry.scheduled": {
      session.busy = true;
      const err = isRecord(data.error) ? trimmed(data.error.message) : "";
      session.retry = {
        attempt: typeof data.attempt === "number" ? data.attempt : 1,
        nextAt: typeof data.at === "number" ? data.at : undefined,
        message: err || undefined
      };
      break;
    }
    case "session.reasoning.started": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "reasoning";
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeReasoningOrdinals.add(ordinal);
      break;
    }
    case "session.reasoning.delta": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "reasoning";
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeReasoningOrdinals.add(ordinal);
      const delta = typeof data.delta === "string" ? data.delta : "";
      session.reasoningChars += delta.length;
      recordStreamVelocity(session, delta.length, now);
      break;
    }
    case "session.reasoning.ended": {
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeReasoningOrdinals.delete(ordinal);
      break;
    }
    case "session.text.started": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "text";
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeTextOrdinals.add(ordinal);
      break;
    }
    case "session.text.delta": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "text";
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeTextOrdinals.add(ordinal);
      const delta = typeof data.delta === "string" ? data.delta : "";
      session.textChars += delta.length;
      recordStreamVelocity(session, delta.length, now);
      break;
    }
    case "session.text.ended": {
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      session.activeTextOrdinals.delete(ordinal);
      break;
    }
    case "session.tool.input.started": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "tool";
      const callId = trimmed(data.id) || `tool-${session.activeTools.size + 1}`;
      const name = trimmed(data.name) || "tool";
      session.activeTools.set(callId, {
        id: callId,
        name,
        status: "input",
        startedAt: now,
        rawBytes: 0
      });
      break;
    }
    case "session.tool.input.delta": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "tool";
      const callId = trimmed(data.id);
      const delta = typeof data.delta === "string" ? data.delta : "";
      session.toolInputChars += delta.length;
      recordStreamVelocity(session, delta.length, now);
      const existing = session.activeTools.get(callId);
      if (existing) {
        existing.rawBytes += delta.length;
      } else if (callId) {
        session.activeTools.set(callId, {
          id: callId,
          name: trimmed(data.name) || "tool",
          status: "input",
          startedAt: now,
          rawBytes: delta.length
        });
      }
      break;
    }
    case "session.tool.input.ended": {
      const callId = trimmed(data.id);
      const text = typeof data.text === "string" ? data.text : "";
      const existing = session.activeTools.get(callId);
      if (existing && text.length > existing.rawBytes) {
        existing.rawBytes = text.length;
      }
      break;
    }
    case "session.tool.called": {
      if (!session.busy) {
        resetTurnMetrics(session, now);
        session.busy = true;
      }
      if (session.stepCount === 0)
        session.stepCount = 1;
      recordFirstToken(session, now);
      session.lastStreamKind = "tool";
      const callId = trimmed(data.id) || `tool-${session.activeTools.size + 1}`;
      const existing = session.activeTools.get(callId);
      const name = trimmed(data.name) || existing?.name || "tool";
      session.activeTools.set(callId, {
        id: callId,
        name,
        status: "running",
        startedAt: now,
        rawBytes: existing?.rawBytes ?? 0,
        detail: extractToolDetail(name, data.input)
      });
      break;
    }
    case "session.tool.progress": {
      const callId = trimmed(data.id);
      const existing = session.activeTools.get(callId);
      if (existing) {
        const detail = extractToolDetail(existing.name, undefined, data.metadata);
        if (detail)
          existing.detail = detail;
      }
      break;
    }
    case "session.tool.success": {
      const callId = trimmed(data.id);
      session.activeTools.delete(callId);
      session.completedTools += 1;
      break;
    }
    case "session.tool.failed": {
      const callId = trimmed(data.id);
      session.activeTools.delete(callId);
      session.failedTools += 1;
      break;
    }
    case "session.compaction.started": {
      session.busy = true;
      session.compacting = true;
      break;
    }
    case "session.compaction.delta": {
      const text = typeof data.text === "string" ? data.text : "";
      recordStreamVelocity(session, text.length, now);
      break;
    }
    case "session.compaction.ended":
    case "session.compaction.failed": {
      session.compacting = false;
      break;
    }
    case "permission.asked": {
      const reqId = trimmed(data.id);
      if (reqId) {
        const resources = Array.isArray(data.resources) ? data.resources.map((r) => trimmed(r)).filter(Boolean) : [];
        session.pendingPermissions.set(reqId, {
          id: reqId,
          action: trimmed(data.action) || "permission",
          resource: resources[0],
          askedAt: now
        });
      }
      break;
    }
    case "permission.replied": {
      const reqId = trimmed(data.requestID) || trimmed(data.id);
      if (reqId)
        session.pendingPermissions.delete(reqId);
      else
        session.pendingPermissions.clear();
      break;
    }
    case "form.created": {
      if (formObj) {
        const formId = trimmed(formObj.id);
        if (formId) {
          session.pendingForms.set(formId, {
            id: formId,
            title: trimmed(formObj.title) || "User input",
            askedAt: now
          });
        }
      }
      break;
    }
    case "form.replied":
    case "form.cancelled":
    case "form.settled": {
      const formId = trimmed(data.id) || trimmed(data.formID);
      if (formId)
        session.pendingForms.delete(formId);
      else
        session.pendingForms.clear();
      break;
    }
    case "session.execution.succeeded":
    case "session.idle": {
      session.busy = false;
      session.turnEndedAt = now;
      session.activeReasoningOrdinals.clear();
      session.activeTextOrdinals.clear();
      session.activeTools.clear();
      session.compacting = false;
      session.retry = null;
      session.pendingPermissions.clear();
      break;
    }
    case "session.execution.interrupted": {
      const reason = trimmed(data.reason);
      if (reason === "shutdown")
        break;
      session.busy = false;
      session.turnEndedAt = now;
      session.activeReasoningOrdinals.clear();
      session.activeTextOrdinals.clear();
      session.activeTools.clear();
      session.compacting = false;
      session.retry = null;
      break;
    }
    case "session.execution.failed":
    case "session.error": {
      session.busy = false;
      session.turnEndedAt = now;
      session.activeReasoningOrdinals.clear();
      session.activeTextOrdinals.clear();
      session.activeTools.clear();
      session.compacting = false;
      session.retry = null;
      const err = isRecord(data.error) ? trimmed(data.error.message) : trimmed(data.error);
      session.lastError = err || "Turn failed";
      break;
    }
    default:
      break;
  }
  updateSessionPhase(store, session, now);
  if (session.parentId) {
    const parent = store.sessions.get(session.parentId);
    if (parent)
      updateSessionPhase(store, parent, now);
  }
};
var FIGURE_SPACE = " ";
var formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0)
    return "0.0s";
  if (ms < 50)
    return "<0.1s";
  if (ms < 60000)
    return `${(ms / 1000).toFixed(1)}s`;
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;
  return `${mins}m ${String(remSecs).padStart(2, "0")}s`;
};
var formatAlignedBarDurations = (msValues) => {
  if (msValues.length === 0)
    return [];
  const safe = msValues.map((ms) => Number.isFinite(ms) && ms > 0 ? ms : 0);
  const maxMs = Math.max(0, ...safe);
  if (maxMs >= 1e6) {
    const parts = safe.map((ms) => {
      const totalSecs = Math.round(ms / 1000);
      const mins = String(Math.floor(totalSecs / 60));
      const secs = String(totalSecs % 60).padStart(2, "0");
      return { mins, secs };
    });
    const targetMinDigits = Math.max(2, ...parts.map((p) => p.mins.length));
    return parts.map(({ mins, secs }) => `${FIGURE_SPACE.repeat(targetMinDigits - mins.length)}${mins}:${secs}`);
  }
  const parts = safe.map((ms) => {
    const effectiveSecs = ms > 0 && ms < 50 ? 0.1 : ms / 1000;
    const fixed = effectiveSecs.toFixed(1);
    const [intPart = "0", decPart = "0"] = fixed.split(".");
    return { intPart, decPart };
  });
  const targetIntDigits = Math.max(2, ...parts.map((p) => p.intPart.length));
  return parts.map(({ intPart, decPart }) => `${FIGURE_SPACE.repeat(targetIntDigits - intPart.length)}${intPart}.${decPart}s`);
};
var formatAlignedTokPerSec = (rate) => {
  const rounded = Math.max(0, Math.round(Number.isFinite(rate) ? rate : 0));
  const digits = String(rounded);
  const pad = Math.max(0, 3 - digits.length);
  return `${FIGURE_SPACE.repeat(pad)}${digits} tok/s`;
};
var formatCompactCount = (n) => {
  if (n < 1000)
    return `${n}`;
  if (n < 1e6)
    return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
};
var toKebabId = (prefix, raw, index) => {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(-24);
  return `${prefix}-${index}-${cleaned || "item"}`.slice(0, 40).replace(/-$/g, "");
};
var clampPercent = (value) => Math.max(0, Math.min(100, value));
var describePhaseHeadline = (store, session, now) => {
  const stepPrefix = session.stepCount > 1 ? `Step ${session.stepCount} · ` : "";
  switch (session.phase) {
    case "waiting-first-token":
      return {
        label: session.stepCount > 1 ? `Step ${session.stepCount} · Waiting for LLM` : "Waiting for first token",
        dot: "info",
        valueTone: "default"
      };
    case "reasoning":
      return {
        label: `${stepPrefix}Thinking`,
        dot: "info",
        valueTone: "default"
      };
    case "tool-input": {
      const first = Array.from(session.activeTools.values()).find((t) => t.status === "input");
      return {
        label: first ? `Tool args · ${first.name}` : `${stepPrefix}Streaming tool args`,
        dot: "accent",
        valueTone: "default"
      };
    }
    case "tool-running": {
      const running = Array.from(session.activeTools.values()).filter((t) => t.status === "running");
      const first = running[0];
      const label = running.length === 1 && first ? `Running · ${first.name}${first.detail ? ` (${first.detail})` : ""}` : `Running ${running.length} tools`;
      return {
        label,
        dot: "warning",
        valueTone: "default"
      };
    }
    case "waiting-permission": {
      const first = session.pendingPermissions.values().next().value;
      return {
        label: first ? `Permission · ${first.action}` : "Waiting for permission",
        dot: "warning",
        valueTone: "warning"
      };
    }
    case "waiting-question": {
      const first = session.pendingForms.values().next().value;
      return {
        label: first ? `Question · ${first.title}` : "Waiting for answer",
        dot: "warning",
        valueTone: "warning"
      };
    }
    case "streaming-text":
      return {
        label: `${stepPrefix}Streaming reply`,
        dot: "accent",
        valueTone: "default"
      };
    case "compacting":
      return {
        label: "Compacting context",
        dot: "warning",
        valueTone: "warning"
      };
    case "retrying": {
      const retry = session.retry;
      const waitSec = retry?.nextAt ? Math.max(0, Math.ceil((retry.nextAt - now) / 1000)) : null;
      return {
        label: waitSec !== null ? `Retry #${retry?.attempt ?? 1} in ${waitSec}s` : `Retry #${retry?.attempt ?? 1}`,
        dot: "warning",
        valueTone: "warning"
      };
    }
    case "finalizing":
      return {
        label: `${stepPrefix}Finishing step`,
        dot: "info",
        valueTone: "muted"
      };
    case "subagent-wait": {
      const activeKids = activeChildSubagentsOf(store, session.sessionId);
      const firstKid = activeKids[0];
      const label = activeKids.length === 1 && firstKid ? `Subagent · ${firstKid.agent || firstKid.title || "working"}` : `Waiting on ${activeKids.length} subagents`;
      return {
        label,
        dot: "info",
        valueTone: "default"
      };
    }
    case "cooldown":
      return {
        label: "Turn complete",
        dot: "success",
        valueTone: "success"
      };
    case "failed":
      return {
        label: session.lastError ? `Failed · ${session.lastError}` : "Turn failed",
        dot: "error",
        valueTone: "error"
      };
    case "idle":
    default: {
      const stepsNote = session.stepCount > 1 ? ` · ${session.stepCount} steps` : "";
      return {
        label: session.turnStartedAt ? `Idle${stepsNote}` : "Idle",
        dot: "muted",
        valueTone: "muted"
      };
    }
  }
};
var getVelocitySeries = (session, now) => {
  const currentSec = Math.floor(now / 1000);
  const values = [];
  for (let i = VELOCITY_WINDOW_SECONDS - 1;i >= 0; i -= 1) {
    const sec = currentSec - i;
    const chars = session.velocityBySecond.get(sec) ?? 0;
    values.push(Math.round(chars / 4));
  }
  const recentChars = (session.velocityBySecond.get(currentSec) ?? 0) + (session.velocityBySecond.get(currentSec - 1) ?? 0);
  return {
    values,
    currentTokPerSec: Math.round(recentChars / 8)
  };
};
var selectTargetSessions = (store, directory) => {
  const normDir = normalizeDirectory(directory);
  const all = Array.from(store.sessions.values());
  let roots = normDir ? all.filter((s) => !s.parentId && s.directory === normDir) : all.filter((s) => !s.parentId);
  if (roots.length === 0 && normDir) {
    roots = all.filter((s) => !s.parentId && !s.directory && (s.busy || s.turnStartedAt !== null));
  }
  if (roots.length === 0) {
    roots = all.filter((s) => !s.parentId);
  }
  if (roots.length === 0 && all.length > 0) {
    roots = [...all];
  }
  roots.sort((a, b) => {
    const aActive = a.busy || a.phase === "subagent-wait" ? 1 : 0;
    const bActive = b.busy || b.phase === "subagent-wait" ? 1 : 0;
    if (aActive !== bActive)
      return bActive - aActive;
    const aHasTurn = a.turnStartedAt !== null ? 1 : 0;
    const bHasTurn = b.turnStartedAt !== null ? 1 : 0;
    if (aHasTurn !== bHasTurn)
      return bHasTurn - aHasTurn;
    return b.lastUpdatedAt - a.lastUpdatedAt;
  });
  const pinnedId = store.selectedSessionByDirectory.get(normDir ?? "__global__");
  const primary = (pinnedId ? roots.find((r) => r.sessionId === pinnedId) : undefined) ?? roots[0] ?? null;
  const switcherCandidates = roots.filter((s) => s.busy || s.phase === "subagent-wait" || s.turnStartedAt !== null).slice(0, 8);
  const children = primary ? all.filter((s) => s.parentId === primary.sessionId).sort((a, b) => Number(b.busy) - Number(a.busy) || b.lastUpdatedAt - a.lastUpdatedAt) : [];
  return { primary, switcherCandidates, children };
};
var buildStatusView = (store, directory, now = Date.now()) => {
  for (const s of store.sessions.values()) {
    updateSessionPhase(store, s, now);
  }
  const { primary, switcherCandidates, children } = selectTargetSessions(store, directory);
  if (!primary || !primary.busy && primary.phase !== "subagent-wait" && primary.turnStartedAt === null) {
    return {
      rows: [
        {
          kind: "note",
          id: "idle-empty",
          text: store.sseConnected ? "Ready — send a prompt to inspect live turn phases." : "Connecting to OpenCode event stream…",
          tone: "muted"
        }
      ]
    };
  }
  const rows = [];
  const controls = [];
  if (switcherCandidates.length > 1) {
    const normKey = normalizeDirectory(directory) ?? "__global__";
    const pinned = store.selectedSessionByDirectory.get(normKey) ?? "auto";
    controls.push({
      kind: "select",
      id: "session",
      label: "Session",
      value: pinned !== "auto" && switcherCandidates.some((c) => c.sessionId === pinned) ? pinned : "auto",
      options: [
        { value: "auto", label: "Auto" },
        ...switcherCandidates.map((c, idx) => {
          const name = c.title || `Chat ${idx + 1}`;
          return {
            value: c.sessionId,
            label: `${c.busy ? "● " : ""}${name}`.slice(0, 48)
          };
        })
      ]
    });
  }
  const isWorking = primary.busy || primary.phase === "subagent-wait";
  const headline = describePhaseHeadline(store, primary, now);
  const phaseElapsedMs = Math.max(0, now - primary.phaseEnteredAt);
  const turnElapsedMs = primary.turnStartedAt ? Math.max(0, (isWorking ? now : primary.turnEndedAt ?? now) - primary.turnStartedAt) : 0;
  const timerValue = isWorking ? `${formatDuration(phaseElapsedMs)} · ${formatDuration(turnElapsedMs)}` : turnElapsedMs > 0 ? formatDuration(turnElapsedMs) : "Ready";
  const estimatedLiveStepTokens = Math.round(primary.stepStreamedChars / 4);
  const generatedTokens = primary.completedOutputTokens + (primary.busy ? estimatedLiveStepTokens : 0);
  const tooltipParts = [
    primary.title ? `Session: ${primary.title}` : null,
    primary.agent ? `Agent: ${primary.agent}` : null,
    primary.modelLabel ? `Model: ${primary.modelLabel}` : null,
    primary.stepCount > 0 ? `Steps: ${primary.stepCount}` : null,
    primary.initialTtftMs !== null ? `Initial TTFT: ${formatDuration(primary.initialTtftMs)}` : null,
    generatedTokens > 0 ? `Generated: ~${formatCompactCount(generatedTokens)} tok` : null
  ].filter(Boolean);
  const tooltipText = tooltipParts.join(" · ").slice(0, 200);
  rows.push({
    kind: "line",
    id: "phase-state",
    label: headline.label.slice(0, 60),
    dot: headline.dot,
    value: timerValue,
    valueTone: headline.valueTone,
    ...tooltipText ? { tooltip: tooltipText } : {}
  });
  const { values: tokSeries, currentTokPerSec } = getVelocitySeries(primary, now);
  const hasStreamActivity = tokSeries.some((v) => v > 0) || isWorking;
  if (hasStreamActivity || primary.peakTokPerSec > 0) {
    const chartMax = Math.max(8, primary.peakTokPerSec, ...tokSeries) * 1.15;
    const displayRate = isWorking ? currentTokPerSec : primary.peakTokPerSec;
    const speedValue = formatAlignedTokPerSec(displayRate);
    const modeNote = isWorking ? "Live stream rate" : `Peak stream rate (${primary.peakTokPerSec} tok/s)`;
    rows.push({
      kind: "line",
      id: "throughput",
      label: "Throughput",
      content: {
        kind: "chart",
        values: tokSeries,
        max: chartMax,
        unit: "count",
        step: 1,
        tone: currentTokPerSec > 0 ? "accent" : "muted"
      },
      value: speedValue,
      valueTone: currentTokPerSec > 0 ? "accent" : "muted",
      tooltip: generatedTokens > 0 ? `${modeNote} · ~${formatCompactCount(generatedTokens)} output tokens this turn` : modeNote
    });
  }
  const d = primary.durationsMs;
  const totalMeasuredMs = Math.max(1, turnElapsedMs, d.ttft + d.reasoning + d.toolInput + d.toolExec + d.text + d.blocked + d.finalize);
  const barRows = [
    {
      id: "bar-ttft",
      label: primary.stepCount > 1 ? `LLM wait (${primary.stepCount})` : "First token",
      ms: d.ttft,
      tone: "info",
      show: d.ttft >= 50 || primary.phase === "waiting-first-token",
      tooltip: primary.initialTtftMs !== null && primary.stepCount > 1 ? `Initial TTFT: ${formatDuration(primary.initialTtftMs)} · Total wait across ${primary.stepCount} steps: ${formatDuration(d.ttft)}` : "Time waiting for the model to emit its first token"
    },
    {
      id: "bar-thinking",
      label: "Thinking",
      ms: d.reasoning,
      tone: "info",
      show: d.reasoning >= 50 || primary.reasoningChars > 0 || primary.phase === "reasoning",
      tooltip: primary.reasoningChars > 0 ? `Reasoning stream (${formatCompactCount(primary.reasoningChars)} chars)` : undefined
    },
    {
      id: "bar-tool-args",
      label: "Tool args",
      ms: d.toolInput,
      tone: "accent",
      show: d.toolInput >= 150 || primary.phase === "tool-input",
      tooltip: primary.toolInputChars > 0 ? `Streaming tool call JSON (${formatCompactCount(primary.toolInputChars)} chars)` : undefined
    },
    {
      id: "bar-tools",
      label: (() => {
        const count = primary.completedTools + primary.failedTools + primary.activeTools.size;
        return count > 0 ? `Tools (${count})` : "Tools";
      })(),
      ms: d.toolExec,
      tone: primary.activeTools.size > 0 ? "warning" : "default",
      show: d.toolExec >= 50 || primary.completedTools > 0 || primary.failedTools > 0 || primary.activeTools.size > 0,
      tooltip: primary.failedTools > 0 ? `${primary.completedTools} succeeded · ${primary.failedTools} failed` : undefined
    },
    {
      id: "bar-reply",
      label: "Reply",
      ms: d.text,
      tone: "success",
      show: d.text >= 50 || primary.textChars > 0 || primary.phase === "streaming-text",
      tooltip: primary.textChars > 0 ? `Assistant reply stream (${formatCompactCount(primary.textChars)} chars)` : undefined
    },
    {
      id: "bar-blocked",
      label: "Blocked",
      ms: d.blocked,
      tone: "warning",
      show: d.blocked >= 100 || primary.phase === "waiting-permission" || primary.phase === "waiting-question" || primary.phase === "retrying" || primary.phase === "subagent-wait",
      tooltip: "Time waiting on permission approval, user answers, retry backoff, or child subagents"
    }
  ];
  const visibleBars = barRows.filter((item) => item.show);
  const alignedValues = formatAlignedBarDurations(visibleBars.map((item) => item.ms));
  for (const [idx, item] of visibleBars.entries()) {
    rows.push({
      kind: "line",
      id: item.id,
      label: item.label,
      content: {
        kind: "bar",
        value: clampPercent(item.ms / totalMeasuredMs * 100),
        tone: item.tone
      },
      value: alignedValues[idx],
      valueTone: "muted",
      ...item.tooltip ? { tooltip: item.tooltip.slice(0, 200) } : {}
    });
  }
  if (primary.activeTools.size > 1) {
    for (const [idx, tool] of Array.from(primary.activeTools.values()).slice(0, 3).entries()) {
      const isInput = tool.status === "input";
      const detail = tool.detail ? ` · ${tool.detail}` : isInput ? " · args" : "";
      rows.push({
        kind: "line",
        id: toKebabId("tool", tool.id, idx),
        label: `↳ ${tool.name}${detail}`.slice(0, 56),
        dot: isInput ? "accent" : "warning",
        value: formatDuration(now - tool.startedAt),
        valueTone: isInput ? "accent" : "warning"
      });
    }
  }
  for (const [idx, child] of children.filter((c) => c.busy).slice(0, 3).entries()) {
    const childHead = describePhaseHeadline(store, child, now);
    const childTurnMs = child.turnStartedAt ? Math.max(0, now - child.turnStartedAt) : 0;
    const who = child.agent || child.title || "subagent";
    rows.push({
      kind: "line",
      id: toKebabId("sub", child.sessionId, idx),
      label: `↳ ${who} · ${childHead.label}`.slice(0, 56),
      dot: childHead.dot,
      value: formatDuration(childTurnMs),
      valueTone: "muted"
    });
  }
  return {
    rows: rows.slice(0, 16),
    ...controls.length > 0 ? { controls } : {}
  };
};
var unwrapResponse = (body) => {
  if (!isRecord(body))
    return body;
  return "data" in body && !("cursor" in body) ? body.data : body;
};
var applySessionRecord = (store, item, now) => {
  const id = trimmed(item.id);
  if (!id)
    return null;
  const s = ensureSession(store, id, now);
  s.hydrated = true;
  s.hydrating = false;
  const parentID = trimmed(item.parentID);
  if (parentID)
    s.parentId = parentID;
  const dir = normalizeDirectory(trimmed(item.directory) || (isRecord(item.location) ? trimmed(item.location.directory) : ""));
  if (dir)
    s.directory = dir;
  const title = trimmed(item.title);
  if (title)
    s.title = title;
  const agent = trimmed(item.agent);
  if (agent)
    s.agent = agent;
  if (isRecord(item.time) && typeof item.time.updated === "number") {
    s.lastUpdatedAt = Math.max(s.lastUpdatedAt, item.time.updated);
  }
  return s;
};
var hydrateSingleSession = async (store, opencodeUrl, token, sessionId, includeTurnStart = false) => {
  if (!/^ses_[\w-]+$/.test(sessionId))
    return;
  const s = ensureSession(store, sessionId);
  if (s.hydrating)
    return;
  s.hydrating = true;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
  try {
    const res = await fetch(`${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const record = unwrapResponse(await res.json().catch(() => null));
      if (isRecord(record)) {
        applySessionRecord(store, record, Date.now());
      }
    }
    if (includeTurnStart && s.busy) {
      const msgRes = await fetch(`${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}/message?limit=6`, {
        headers,
        signal: AbortSignal.timeout(5000)
      });
      if (msgRes.ok) {
        const rawMsgs = await msgRes.json().catch(() => null);
        const list = Array.isArray(rawMsgs) ? rawMsgs : isRecord(rawMsgs) && Array.isArray(rawMsgs.data) ? rawMsgs.data : [];
        for (let i = list.length - 1;i >= 0; i -= 1) {
          const entry = list[i];
          const info = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
          if (isRecord(info) && trimmed(info.role) === "user" && isRecord(info.time) && typeof info.time.created === "number") {
            s.turnStartedAt = info.time.created;
            break;
          }
        }
      }
    }
  } catch {} finally {
    s.hydrating = false;
  }
};
var hydrateInitialSessions = async (store, opencodeUrl, token) => {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
  try {
    const [sessionsRes, activeRes] = await Promise.all([
      fetch(`${opencodeUrl}/api/session?limit=50`, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null),
      fetch(`${opencodeUrl}/api/session/active`, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null)
    ]);
    const now = Date.now();
    if (sessionsRes?.ok) {
      const raw = await sessionsRes.json().catch(() => null);
      const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
      for (const item of list) {
        if (isRecord(item))
          applySessionRecord(store, item, now);
      }
    }
    if (activeRes?.ok) {
      const activeData = unwrapResponse(await activeRes.json().catch(() => null));
      if (isRecord(activeData)) {
        for (const [id, st] of Object.entries(activeData)) {
          const s = ensureSession(store, id, now);
          s.busy = true;
          if (s.turnStartedAt === null)
            s.turnStartedAt = now;
          if (isRecord(st) && trimmed(st.type) === "retry") {
            s.retry = {
              attempt: typeof st.attempt === "number" ? st.attempt : 1,
              nextAt: typeof st.next === "number" ? st.next : undefined,
              message: trimmed(st.message) || undefined
            };
          }
          updateSessionPhase(store, s, now);
          hydrateSingleSession(store, opencodeUrl, token, id, true);
        }
      }
    }
  } catch {}
};
var connectEventStream = (store, opencodeUrl, token) => {
  let backoffMs = 1000;
  const loop = async () => {
    while (true) {
      try {
        const res = await fetch(`${opencodeUrl}/api/event`, {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`
          }
        });
        if (!res.ok || !res.body) {
          store.sseConnected = false;
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 15000);
          continue;
        }
        store.sseConnected = true;
        backoffMs = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buffer = "";
        let dataLines = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done)
            break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIdx = buffer.indexOf(`
`);
          while (newlineIdx !== -1) {
            const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, "");
            buffer = buffer.slice(newlineIdx + 1);
            if (rawLine === "") {
              if (dataLines.length > 0) {
                const payloadText = dataLines.join(`
`);
                dataLines = [];
                try {
                  const parsed = JSON.parse(payloadText);
                  applyWireEvent(store, parsed, Date.now());
                } catch {}
              }
            } else if (rawLine.startsWith("data:")) {
              dataLines.push(rawLine.slice(5).trimStart());
            }
            newlineIdx = buffer.indexOf(`
`);
          }
        }
      } catch {
        store.sseConnected = false;
      }
      store.sseConnected = false;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 15000);
    }
  };
  loop();
};
var startServer = () => {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (!port || !token)
    return null;
  const opencodeUrl = process.env.OPENCHAMBER_OPENCODE_URL;
  const store = createTrackerStore((sessionId) => {
    if (opencodeUrl) {
      hydrateSingleSession(store, opencodeUrl, token, sessionId, false);
    }
  });
  if (opencodeUrl) {
    hydrateInitialSessions(store, opencodeUrl, token);
    connectEventStream(store, opencodeUrl, token);
  }
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && reqUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    if (reqUrl.pathname === "/status") {
      const directory = reqUrl.searchParams.get("directory")?.trim() || null;
      if (req.method === "GET") {
        const view = buildStatusView(store, directory, Date.now());
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(view));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const action = body ? JSON.parse(body) : {};
            const normKey = normalizeDirectory(directory) ?? "__global__";
            if (action.id === "session" && typeof action.value === "string") {
              if (action.value === "auto") {
                store.selectedSessionByDirectory.delete(normKey);
              } else {
                store.selectedSessionByDirectory.set(normKey, action.value);
              }
              res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
              return;
            }
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: `Unknown control: ${action.id}` }));
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: error?.message || "Invalid action payload" }));
          }
        });
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  });
  server.listen(port, "127.0.0.1");
  return server;
};
if (process.env.OPENCHAMBER_SERVICE_PORT && process.env.OPENCHAMBER_SERVICE_TOKEN) {
  startServer();
}
export {
  accruePhaseDuration,
  applyWireEvent,
  buildStatusView,
  createTrackerStore,
  derivePhase,
  describePhaseHeadline,
  ensureSession,
  formatAlignedBarDurations,
  formatAlignedTokPerSec,
  formatCompactCount,
  formatDuration,
  normalizeDirectory,
  phaseToBucket,
  selectTargetSessions,
  startServer,
  updateSessionPhase
};
