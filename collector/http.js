import { setTimeout as delay } from 'node:timers/promises';

export class Stop extends Error {
  constructor(reason, code = 3) {
    super(reason);
    this.code = code;
  }
}
export function retryAfter(value, now) {
  const seconds = /^\d+$/.test(value ?? '') ? Number(value) * 1000 : NaN;
  const date = Number.isFinite(seconds) ? now + seconds : Date.parse(value);
  return Math.max(now + 900_000, Number.isFinite(date) ? date : 0);
}

export async function scheduleRetry(gate, attempt) {
  // Persist the delay so restarting cannot bypass the retry backoff.
  gate.state.nextAt = Math.max(
    gate.state.nextAt ?? 0,
    gate.now() + (attempt === 1 ? 60_000 : 180_000) + gate.random() * 5000,
  );
  await gate.save(gate.state);
}

export function robotsRules(text, agent = 'kanjipedia-link-collector') {
  const groups = [];
  let group = null,
    hasRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!group || hasRule) {
        group = { agents: [], rules: [], delay: 0 };
        groups.push(group);
        hasRule = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(key)) {
      hasRule = true;
      if (key === 'crawl-delay') {
        if (!/^\d+(\.\d+)?$/.test(value))
          throw new Stop('Invalid robots Crawl-delay');
        group.delay = Math.max(group.delay, Number(value) * 1000);
      } else if (value) group.rules.push({ allow: key === 'allow', value });
    }
  }
  if (!groups.length) throw new Stop('Unrecognized robots.txt');
  const specificity = (g) =>
    Math.max(
      ...g.agents.map((a) =>
        a === '*' ? 0 : agent.includes(a) ? a.length : -1,
      ),
    );
  const best = Math.max(...groups.map(specificity));
  const selected = groups.filter((g) => best >= 0 && specificity(g) === best);
  return {
    delay: Math.max(0, ...selected.map((g) => g.delay)),
    rules: selected.flatMap((g) => g.rules),
  };
}
export function robotsAllowed(rules, url) {
  const u = new URL(url),
    target = u.pathname + u.search;
  const matching = rules.rules
    .filter((rule) => {
      const pattern = rule.value
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${pattern.replace(/\\\$$/, '$')}`).test(target);
    })
    .sort(
      (a, b) =>
        b.value.length - a.value.length || Number(b.allow) - Number(a.allow),
    );
  return !matching.length || matching[0].allow;
}
export function blockedBody(body) {
  return /captcha|cf-chl-|access\s+denied|アクセスが制限|アクセスを制限|ロボットではない|不正なアクセス/iu.test(
    body,
  );
}

export class HttpGate {
  constructor({
    state,
    save,
    request = fetch,
    now = Date.now,
    sleep = delay,
    random = Math.random,
    maxRequests = 10,
    cancelled = () => false,
    recordResponse = async () => {},
    allowedHosts = ['www.kanjipedia.jp', 'www.kanken.or.jp'],
  }) {
    Object.assign(this, {
      state,
      save,
      request,
      now,
      sleep,
      random,
      maxRequests,
      cancelled,
      recordResponse,
      allowedHosts,
    });
    this.used = 0;
    this.busy = false;
  }
  async get(url, { robots = true } = {}) {
    if (this.busy) throw new Stop('Concurrent request rejected');
    this.busy = true;
    try {
      for (let redirects = 0; ; redirects++) {
        if (this.cancelled()) throw new Stop('Interrupted before request', 2);
        const u = new URL(url);
        if (
          u.protocol !== 'https:' ||
          !this.allowedHosts.includes(u.hostname) ||
          u.port ||
          u.username ||
          u.password
        )
          throw new Stop('Unapproved request host');
        const policy = this.state.robots?.[u.origin];
        if (robots && (!policy || this.now() - policy.checkedAt > 86_400_000))
          throw new Stop('Refresh robots first');
        if (robots && !robotsAllowed(policy, url))
          throw new Stop(`robots disallows ${url}`);
        if ((this.state.consecutiveFailures ?? 0) >= 3)
          throw new Stop(
            'Three consecutive HTTP failures; inspect evidence and use reset-failures',
          );
        if (this.now() < (this.state.cooldownUntil ?? 0))
          throw new Stop(
            `Cooling down until ${new Date(this.state.cooldownUntil).toISOString()}`,
          );
        if (this.used >= this.maxRequests)
          throw new Stop('Invocation request limit reached', 2);
        await this.sleep(Math.max(0, (this.state.nextAt ?? 0) - this.now()));
        if (this.cancelled()) throw new Stop('Interrupted before request', 2);
        const day = new Date(this.now()).toISOString().slice(0, 10);
        if (this.state.day !== day) {
          this.state.day = day;
          this.state.count = 0;
        }
        this.state.dailyLimit ??= 500;
        if (this.state.count >= this.state.dailyLimit)
          throw new Stop('UTC daily limit reached', 2);
        // A crash leaves a conservative timeout + inter-request gap reservation.
        this.state.lastAt = this.now();
        this.state.nextAt =
          this.now() +
          30_000 +
          Math.max(10_000, policy?.delay ?? 0) +
          this.random() * 5000;
        this.state.count++;
        this.used++;
        await this.save(this.state);
        let response, body, failure;
        try {
          response = await this.request(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(30_000),
            headers: {
              'User-Agent':
                'Kanjipedia-Link-Collector/0.1 (private local research; no proxy)',
              Accept: 'text/html,text/plain;q=0.9',
            },
          });
          body = await response.text();
        } catch (error) {
          failure = error;
        }
        this.state.nextAt =
          this.now() +
          Math.max(10_000, policy?.delay ?? 0) +
          this.random() * 5000;
        const headers = {};
        for (const key of [
          'content-type',
          'location',
          'retry-after',
          'etag',
          'last-modified',
        ]) {
          const value = response?.headers.get(key);
          if (value) headers[key] = value;
        }
        const result = {
          url,
          status: response?.status ?? 0,
          headers,
          body: body ?? '',
          fetchedAt: new Date(this.now()).toISOString(),
        };
        this.state.events ??= [];
        this.state.events.push({
          ...result,
          body: undefined,
          error: failure?.message,
        });
        this.state.events = this.state.events.slice(-1000);
        if (failure || result.status >= 500)
          this.state.consecutiveFailures =
            (this.state.consecutiveFailures ?? 0) + 1;
        else this.state.consecutiveFailures = 0;
        if (result.status === 429) {
          this.state.cooldownUntil = retryAfter(
            headers['retry-after'],
            this.now(),
          );
          this.state.rateLimitStops = (this.state.rateLimitStops ?? 0) + 1;
        }
        await this.save(this.state);
        await this.recordResponse(result);
        if (result.status === 429)
          throw new Stop('HTTP 429: persisted global cooldown');
        if ([401, 403].includes(result.status) || blockedBody(body ?? ''))
          throw new Stop(`Access blocked: HTTP ${result.status}`);
        if ((this.state.consecutiveFailures ?? 0) >= 3)
          throw new Stop('Three consecutive HTTP failures');
        if (failure) {
          const error = new Error(`Network/timeout: ${failure.message}`);
          error.retryable = true;
          throw error;
        }
        if (result.status >= 500) {
          const error = new Error(`HTTP ${result.status}`);
          error.retryable = true;
          error.response = result;
          throw error;
        }
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          if (redirects >= 3 || !headers.location)
            throw new Stop('Redirect limit/invalid redirect');
          const target = new URL(headers.location, url);
          if (target.origin !== u.origin)
            throw new Stop('Cross-origin redirect rejected');
          url = target.href;
          continue;
        }
        // RFC 9309 section 2.3.1.3: a missing robots resource is distinct from
        // a missing search page. Authentication, blocking and 429 still stop above.
        if (!robots && u.pathname === '/robots.txt' && result.status === 404)
          return result;
        if (result.status !== 200 || !body.trim())
          throw new Stop(`Unexpected/empty response: HTTP ${result.status}`);
        return result;
      }
    } finally {
      this.busy = false;
    }
  }
  async ensureRobots(origin, { force = false } = {}) {
    const existing = this.state.robots?.[origin];
    if (!force && existing && this.now() - existing.checkedAt < 86_400_000)
      return existing;
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await this.get(`${origin}/robots.txt`, { robots: false });
        break;
      } catch (error) {
        if (!error.retryable || attempt === 3) throw error;
        await scheduleRetry(this, attempt);
      }
    }
    const policy = {
      ...(result.status === 404
        ? { delay: 0, rules: [], unavailable: true }
        : robotsRules(result.body)),
      checkedAt: this.now(),
      evidence: result,
    };
    this.state.robots ??= {};
    this.state.robots[origin] = policy;
    await this.save(this.state);
    return policy;
  }
}
