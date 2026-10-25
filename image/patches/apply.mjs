// Applies the Railway patches to a Papermark checkout (cwd). Every edit must
// match its anchor exactly once, so an upstream change fails the image build
// loudly instead of shipping a half-patched app.
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function edit(file, find, replace) {
  const src = readFileSync(file, "utf8");
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(`${file}: anchor matched ${count}x: ${find.slice(0, 80)}`);
  writeFileSync(file, src.replace(find, () => replace));
}

function editAll(file, find, replace, expected) {
  const src = readFileSync(file, "utf8");
  const count = src.split(find).length - 1;
  if (count !== expected) throw new Error(`${file}: anchor matched ${count}x, wanted ${expected}: ${find.slice(0, 80)}`);
  writeFileSync(file, src.split(find).join(replace));
}

// 1. New files: trigger shim, its progress API, the Postgres Tinybird port.
cpSync(join(here, "files"), ".", { recursive: true });

// 2. Railway hosting: the app's own *.up.railway.app host is not a customer
// custom domain (upstream treats every host but papermark.com/vercel.app as
// one), remote page images come from the bucket's virtual host (Railway buckets: <bucket>.t3.storageapi.dev), and the
// type check is skipped (the shims below are deliberately looser than the
// real SDK types; upstream type-checks its own code in CI).
edit(
  "middleware.ts",
  `        host?.includes("localhost") ||`,
  `        host?.split(":")[0] === process.env.NEXT_PUBLIC_APP_BASE_HOST ||
        host?.includes("localhost") ||`,
);
edit(
  "next.config.mjs",
  `  reactStrictMode: true,`,
  `  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },`,
);
edit(
  "next.config.mjs",
  `    { protocol: "https", hostname: "faisalman.github.io" },`,
  `    { protocol: "https", hostname: "faisalman.github.io" },
    { protocol: "https", hostname: "**.storageapi.dev" },`,
);

// auth-options names the session cookie without the __Secure- prefix off
// Vercel, but getToken infers the prefixed name from an https NEXTAUTH_URL,
// so every signed-in request was bounced back to /login.
edit(
  "lib/middleware/app.ts",
  `    secret: process.env.NEXTAUTH_SECRET,\n  })) as {`,
  `    secret: process.env.NEXTAUTH_SECRET,\n    secureCookie: false,\n  })) as {`,
);

// The tus upload store builds its S3 clients without the configured
// endpoint (the "omit endpoint if empty" comments have no code behind them),
// so uploads only ever worked against AWS itself.
editAll(
  "ee/features/storage/s3-store.ts",
  `      region: euConfig.region,\n      credentials: {`,
  `      region: euConfig.region,\n      ...(euConfig.endpoint ? { endpoint: euConfig.endpoint } : {}),\n      credentials: {`,
  2,
);
edit(
  "ee/features/storage/s3-store.ts",
  `        region: this.usConfig.region,\n        credentials: {`,
  `        region: this.usConfig.region,\n        ...(this.usConfig.endpoint ? { endpoint: this.usConfig.endpoint } : {}),\n        credentials: {`,
);

// 3. Optional SaaS that upstream requires at import or on signup.
// Hanko (passkeys) throws at import when unset, taking every auth route down.
edit(
  "lib/hanko.ts",
  `if (!process.env.HANKO_API_KEY || !process.env.NEXT_PUBLIC_HANKO_TENANT_ID) {`,
  `if (false) {`,
);
edit("lib/hanko.ts", `apiKey: process.env.HANKO_API_KEY!,`, `apiKey: process.env.HANKO_API_KEY || "unset",`);
edit(
  "lib/hanko.ts",
  `tenantId: process.env.NEXT_PUBLIC_HANKO_TENANT_ID!,`,
  `tenantId: process.env.NEXT_PUBLIC_HANKO_TENANT_ID || "unset",`,
);
// QStash schedules the welcome email; without a token the publish throws
// inside NextAuth's createUser event and the first email sign-in fails.
edit(
  "lib/auth/auth-options.ts",
  `      await qstash.publishJSON({`,
  `      if (process.env.QSTASH_TOKEN) await qstash.publishJSON({`,
);

// Slack is an optional integration whose client throws in its constructor,
// and lib/integrations/slack/events.ts instantiates it at import.
edit(
  "lib/integrations/slack/client.ts",
  `      throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set");`,
  `      return;`,
);

// 4. Email goes out as the deployer's own verified sender, never as
// papermark.com (which no deployer's Resend key can send from).
edit(
  "lib/resend.ts",
  `  const fromAddress =\n    from ??`,
  `  const fromAddress =\n    (process.env.EMAIL_FROM || null) ??\n    from ??`,
);
edit(
  "lib/resend.ts",
  `replyTo: marketing ? "marc@papermark.com" : replyTo,`,
  `replyTo,`,
);

// 5. Admin password sign-in: the deploy is usable before any email provider
// is configured. Only ADMIN_EMAIL can use it, and only while ADMIN_PASSWORD
// is set; the user row is created on first sign-in.
edit(
  "lib/auth/auth-options.ts",
  `import CredentialsProvider from "next-auth/providers/credentials";`,
  `import CredentialsProvider from "next-auth/providers/credentials";
import { timingSafeEqual } from "crypto";`,
);
edit(
  "lib/auth/auth-options.ts",
  `    PasskeyProvider({`,
  `    CredentialsProvider({
      id: "admin-password",
      name: "Admin password",
      credentials: {
        email: { type: "email" },
        password: { type: "password" },
      },
      async authorize(credentials) {
        const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD;
        const email = credentials?.email?.trim().toLowerCase();
        if (!adminEmail || !adminPassword || !email || !credentials?.password) return null;
        const given = Buffer.from(credentials.password);
        const expected = Buffer.from(adminPassword);
        if (
          email !== adminEmail ||
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        ) {
          return null;
        }
        return prisma.user.upsert({
          where: { email },
          create: { email, name: email.split("@")[0], emailVerified: new Date() },
          update: {},
        });
      },
    }),
    PasskeyProvider({`,
);
const login = "app/(auth)/login/page-client.tsx";
edit(
  login,
  `  const [email, setEmail] = useState<string>("");`,
  `  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");`,
);
edit(
  login,
  `              e.preventDefault();`,
  `              e.preventDefault();
              if (password) {
                setClickedMethod("email");
                signIn("admin-password", {
                  email,
                  password,
                  redirect: false,
                }).then((res) => {
                  if (res?.ok && !res?.error) {
                    router.push(next && next.length > 0 ? next : "/dashboard");
                  } else {
                    toast.error("Wrong email or password");
                    setClickedMethod(undefined);
                  }
                });
                return;
              }`,
);
edit(
  login,
  `            />
            <div className="relative">
              <Button
                type="submit"`,
  `            />
            <Label className="sr-only" htmlFor="password">
              Password
            </Label>
            <Input
              id="password"
              placeholder="Admin password (blank = email link)"
              type="password"
              autoComplete="current-password"
              disabled={clickedMethod === "email"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-10 w-full rounded-[4px] border-0 bg-white px-3 py-2 text-sm text-gray-900 ring-1 ring-gray-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-white"
            />
            <div className="relative">
              <Button
                type="submit"`,
);
edit(login, `                {emailButtonText}`, `                {password ? "Sign in" : emailButtonText}`);

// 6. Tinybird -> Postgres (lib/tinybird/pg.ts).
for (const f of ["lib/tinybird/publish.ts", "lib/tinybird/pipes.ts"]) {
  edit(f, `import { Tinybird } from "@chronark/zod-bird";`, `import { Tinybird } from "./pg";`);
}

// 7. Trigger.dev -> in-process shim. Webpack aliases both packages; the
// registry maps task ids to lazy imports for tasks.trigger("<id>") calls,
// which only import the task module as a type.
// The browser bundle gets an inert stub: client components reach the SDK
// through shared helpers, and the real shim needs node:async_hooks.
edit("next.config.mjs", `  webpack: (config) => {`, `  webpack: (config, { isServer }) => {`);
edit(
  "next.config.mjs",
  `      "@google-cloud/kms": false,`,
  `      "@trigger.dev/sdk$": \`\${process.cwd()}/lib/trigger-shim/\${isServer ? "sdk" : "client"}.ts\`,
      "@trigger.dev/react-hooks$": \`\${process.cwd()}/lib/trigger-shim/react-hooks.ts\`,
      "@google-cloud/kms": false,`,
);
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (["node_modules", ".next", ".git"].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
const entries = [];
for (const file of walk(".")) {
  if (file.startsWith("lib/trigger-shim")) continue;
  const src = readFileSync(file, "utf8");
  if (!src.includes('from "@trigger.dev/sdk"')) continue;
  const re = /export const (\w+)\s*=\s*(?:task|schemaTask|schedules\.task)\(\{\s*id:\s*"([^"]+)"/g;
  for (const [, name, id] of src.matchAll(re)) {
    const mod = "@/" + relative(".", file).replace(/\.tsx?$/, "");
    entries.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(mod)}).then((m) => (m as any)[${JSON.stringify(name)}]),`);
  }
}
if (entries.length < 20) throw new Error(`only ${entries.length} trigger tasks found`);
writeFileSync(
  "lib/trigger-shim/registry.ts",
  `// Generated by image/patches/apply.mjs: task id -> lazy task definition.\nexport const registry = {\n${entries.join("\n")}\n};\n`,
);
console.log(`registered ${entries.length} trigger tasks`);
