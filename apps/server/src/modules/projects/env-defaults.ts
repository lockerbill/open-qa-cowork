/**
 * Safe-by-default AI permission flags per environment name (spec §10.6). A new
 * environment starts from these defaults; the request may override individual
 * flags. Unknown names fall back to the conservative `custom` profile.
 */
export interface EnvFlags {
  allowAiObserve: boolean;
  allowAiGenerate: boolean;
  allowAiExecute: boolean;
  allowAutoSubmit: boolean;
  requireConfirmationBeforeSubmit: boolean;
  requireConfirmationBeforeAttachmentUpload: boolean;
}

export const ENV_DEFAULTS: Record<string, EnvFlags> = {
  local: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: true,
    allowAutoSubmit: true,
    requireConfirmationBeforeSubmit: false,
    requireConfirmationBeforeAttachmentUpload: false,
  },
  dev: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: true,
    allowAutoSubmit: true,
    requireConfirmationBeforeSubmit: false,
    requireConfirmationBeforeAttachmentUpload: true,
  },
  // staging permits auto-submit but only with confirmation (spec "With confirmation").
  staging: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: true,
    allowAutoSubmit: true,
    requireConfirmationBeforeSubmit: true,
    requireConfirmationBeforeAttachmentUpload: true,
  },
  uat: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: false,
    allowAutoSubmit: false,
    requireConfirmationBeforeSubmit: true,
    requireConfirmationBeforeAttachmentUpload: true,
  },
  production: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: false,
    allowAutoSubmit: false,
    requireConfirmationBeforeSubmit: true,
    requireConfirmationBeforeAttachmentUpload: true,
  },
  custom: {
    allowAiObserve: true,
    allowAiGenerate: true,
    allowAiExecute: false,
    allowAutoSubmit: false,
    requireConfirmationBeforeSubmit: true,
    requireConfirmationBeforeAttachmentUpload: true,
  },
};

export function flagsForEnv(name: string): EnvFlags {
  return ENV_DEFAULTS[name] ?? ENV_DEFAULTS.custom!;
}
