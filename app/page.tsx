export default function HomePage() {
  return (
    <div className="flex flex-col gap-16 max-w-2xl mx-auto">
      <section>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Anush Mattapalli
        </h1>
        <p className="mt-3 text-base sm:text-lg text-stone-500 dark:text-stone-400">
          Software engineer · food enthusiast · photographer
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <SocialLink
            href="https://www.linkedin.com/in/anush96/"
            label="LinkedIn"
            icon={<LinkedInIcon />}
          />
          <SocialLink
            href="https://www.instagram.com/matanatr96/"
            label="@matanatr96"
            icon={<InstagramIcon />}
          />
          <SocialLink
            href="https://www.instagram.com/amphototography/"
            label="@amphototography"
            icon={<InstagramIcon />}
          />
        </div>
      </section>
    </div>
  );
}

function SocialLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-stone-200 dark:border-stone-800 text-sm text-stone-700 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-500 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
    >
      {icon}
      {label}
    </a>
  );
}

function InstagramIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}
