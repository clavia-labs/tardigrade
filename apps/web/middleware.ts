// middleware.ts at the project root, for a site on Vercel that isn't Next.js (Vite, Astro, SvelteKit,
// Remix, plain HTML): Vercel Routing Middleware. Letter server snippet v2: install once.
// Counts AI agents and crawlers that never run JavaScript and visits from AI answers; what it
// forwards is decided by Letter and updates on its own. Returns nothing, so every request passes
// through unchanged, and never sends cookies or credentials.
type LetterRules = { v: number; ttl: number; all: boolean; ua: string; path: string; referer: string; query: string; headers: string[]; skip: string };
const LETTER_KEY = "lv_pub_9jnkid6ilifkf81ggzof3qul";
const LETTER_ENDPOINT = "https://lettervisit.com/api/v1/agent-visit";
const LETTER_RULES_URL = "https://app.letterstory.com/api/visitors/snippet-rules?kind=vercel&k=lv_pub_9jnkid6ilifkf81ggzof3qul";
const LETTER_DROP = new Set(["cookie","set-cookie","authorization","proxy-authorization","x-api-key","x-auth-token","x-csrf-token","x-vercel-oidc-token","cf-access-jwt-assertion"]);
// Which requests to forward comes from Letter and refreshes on its own; these are the defaults
// until the first refresh, and if it ever fails.
let letterRules = letterCompile({"v":2,"ttl":600,"all":false,"ua":"bot|crawl|spider|agent|fetch|chatgpt|claude|perplexity|anthropic|openai|gemini|google|mistral|cohere|externalhit|-user\\b|letter-visitors-sitecheck|^curl/|^wget/|python-requests|python-urllib|python-httpx|aiohttp|^node\\b|undici|axios/|got \\(|^go-http-client|okhttp|^java/|libwww-perl|^ruby\\b|guzzlehttp|^php\\b|scrapy|^httpie","path":"(^|/)(llms(-full)?\\.txt|agents\\.md)$|\\.mdx?$","referer":"chatgpt|openai|claude|perplexity|gemini|copilot","query":"utm_source=(chatgpt|openai|claude|perplexity|gemini|copilot)","headers":["signature-agent","signature"],"skip":"\\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3)$|^/_next/"});
let letterFetchedAt = 0;

function letterCompile(r: LetterRules) {
	const re = (s: string) => new RegExp(s, "i");
	return { ...r, re: { ua: re(r.ua), path: re(r.path), referer: re(r.referer), query: re(r.query), skip: re(r.skip) } };
}

function letterRefresh(): Promise<void> | null {
	if (Date.now() - letterFetchedAt < letterRules.ttl * 1000) return null;
	letterFetchedAt = Date.now();
	return fetch(LETTER_RULES_URL)
		.then((r) => r.json())
		.then((r: LetterRules) => {
			if (r && r.v === 2) letterRules = letterCompile(r);
		})
		.catch(() => {});
}

function letterWanted(pathname: string, search: string, get: (name: string) => string | null, has: (name: string) => boolean): boolean {
	const r = letterRules;
	if (r.re.skip.test(pathname)) return false;
	return (
		r.all ||
		r.re.ua.test(get("user-agent") || "") ||
		r.headers.some((n: string) => has(n)) ||
		r.re.path.test(pathname) ||
		r.re.referer.test(get("referer") || "") ||
		r.re.query.test(search)
	);
}

function letterQuery(params: Iterable<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of params) if (/^(utm_[a-z]+|ref)$/i.test(name)) out[name] = value;
	return out;
}

export default function middleware(request: Request, context?: { waitUntil?(promise: Promise<unknown>): void }) {
	const keep = (p: Promise<unknown>) => (context?.waitUntil ? context.waitUntil(p) : void p);
	const refreshing = letterRefresh();
	if (refreshing) keep(refreshing);
	const url = new URL(request.url);
	const h = request.headers;
	if (letterWanted(url.pathname, url.search, (n: string) => h.get(n), (n: string) => h.has(n))) {
		const headers: Record<string, string> = {};
		h.forEach((value, name) => {
			if (!LETTER_DROP.has(name)) headers[name] = value;
		});
		keep(
			fetch(LETTER_ENDPOINT, {
				method: "POST",
				body: JSON.stringify({
					k: LETTER_KEY,
					v: 2,
					kind: "vercel",
					scope: letterRules.all ? "all" : "agents",
					method: request.method,
					url: url.origin + url.pathname,
					query: letterQuery(url.searchParams),
					ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
					headers,
				}),
			}).catch(() => {}),
		);
	}
}

// Every page and agent file; built assets skipped.
export const config = { matcher: ["/((?!assets/|_astro/|_app/|favicon.ico).*)"] };
