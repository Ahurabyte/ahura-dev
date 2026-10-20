/**
 * Knowledge Base concepts — the topic hubs of ahura.dev.
 *
 * Each concept is a durable definition page (HTML + Markdown mirror) that
 * links the articles covering it. `tag` points at the Persian tag used in
 * post frontmatter; concepts without a tag yet are hubs-in-preparation and
 * say so honestly on their page.
 */
export interface Concept {
  slug: string;
  name: string;
  nameFa?: string;
  description: string;
  tag?: string;
  category: "Artificial Intelligence" | "Programming" | "Research";
}

export const CONCEPTS: Concept[] = [
  {
    slug: "ai-agents",
    name: "AI Agents",
    nameFa: "ایجنت‌های هوش مصنوعی",
    category: "Artificial Intelligence",
    description:
      "AI agents are software systems that perceive a goal, plan steps, use tools (APIs, browsers, code execution) and act in a loop until the goal is met or they escalate to a human. Unlike a single chat completion, an agent owns state across steps: it reads results, corrects course, and chains capabilities together.",
  },
  {
    slug: "mcp",
    name: "Model Context Protocol (MCP)",
    nameFa: "پروتکل MCP",
    category: "Artificial Intelligence",
    description:
      "The Model Context Protocol (MCP) is an open standard for connecting AI models to external tools and data sources through a uniform client–server interface. An MCP server exposes tools, resources and prompts; any MCP-compatible client (assistant, IDE, agent runtime) can discover and call them without bespoke glue code.",
  },
  {
    slug: "artificial-intelligence",
    name: "Artificial Intelligence",
    nameFa: "هوش مصنوعی",
    category: "Artificial Intelligence",
    tag: "هوش‌مصنوعی",
    description:
      "Artificial intelligence covers systems that perform tasks associated with human cognition — prediction, generation, planning, perception. On this site the term appears both as a research subject (e.g. AI in clinical care) and as a practical engineering material to build with.",
  },
  {
    slug: "astro",
    name: "Astro",
    nameFa: "فریم‌ورک آسترو",
    category: "Programming",
    description:
      "Astro is a web framework for content-driven sites. It renders pages to static HTML at build time and ships zero JavaScript by default; interactive parts are added as isolated 'islands'. This makes Astro a strong fit for blogs that must be readable by humans, search engines and AI agents alike — the full article text is present in the initial HTML, with no client-side fetching.",
  },
  {
    slug: "open-source",
    name: "Open Source",
    nameFa: "اوپن‌سورس",
    category: "Programming",
    tag: "اوپن‌سورس",
    description:
      "Open-source software is released under a license that lets anyone inspect, modify and redistribute the code. The interesting questions are economic as much as technical: who maintains the commons, how quality and security stay credible, and when open alternatives can realistically replace commercial products.",
  },
  {
    slug: "programming",
    name: "Programming",
    nameFa: "برنامه‌نویسی",
    category: "Programming",
    tag: "برنامه‌نویسی",
    description:
      "Programming is the craft of expressing solutions precisely enough for a machine to execute them. Notes under this topic cover fundamentals, algorithms and the habits that turn 'it works' into 'it is correct, clear and robust'.",
  },
  {
    slug: "computer-science",
    name: "Computer Science",
    nameFa: "علوم کامپیوتر",
    category: "Programming",
    tag: "علوم‌کامپیوتر",
    description:
      "Computer science studies computation itself: what can be computed, at what cost, and what structures emerge from simple rules. Cellular automata, complexity and computability are recurring themes here.",
  },
  {
    slug: "mathematics",
    name: "Mathematics",
    nameFa: "ریاضیات",
    category: "Research",
    tag: "ریاضیات",
    description:
      "Mathematics on this site usually arrives through concrete systems — a grid, a rule, a pattern — rather than abstract proof. The goal is intuition first: small examples whose behaviour can be fully traced by hand.",
  },
  {
    slug: "technology",
    name: "Technology",
    nameFa: "تکنولوژی",
    category: "Research",
    tag: "تکنولوژی",
    description:
      "Technology notes: tools, platforms and shifts in how software gets built and used, written from a practitioner's point of view rather than a press release.",
  },
];

export const conceptBySlug = (slug: string) => CONCEPTS.find((c) => c.slug === slug);
