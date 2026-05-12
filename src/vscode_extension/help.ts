export const HELP_EMAIL = 'marcus@smithstreetsoftware.com';
const HELP_SUBJECT = 'little-oxford help';
export const HELP_COMMAND_ID = 'little-oxford.openHelp';
export const HELP_DISCUSSIONS_URL = 'https://github.com/marcusraty/project-little-oxford/discussions/new';

export function helpMailtoUrl(): string {
  return `mailto:${HELP_EMAIL}?subject=${encodeURIComponent(HELP_SUBJECT)}`;
}

export interface HelpMenuItem {
  label: string;
  description: string;
  url: string;
}

export function helpMenuItems(): HelpMenuItem[] {
  return [
    {
      label: `$(mail) Email maintainer (${HELP_EMAIL.split('@')[0]})`,
      description: HELP_EMAIL,
      url: helpMailtoUrl(),
    },
    {
      label: '$(comment-discussion) Start a GitHub discussion',
      description: 'project-little-oxford on GitHub',
      url: HELP_DISCUSSIONS_URL,
    },
  ];
}
