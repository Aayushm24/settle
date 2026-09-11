interface CommandMember {
  id: string;
  name: string;
}

interface CommandReceipt {
  id: string;
  sourceName: string;
  merchant: string;
  bookingIds: string[];
}

export type TransactionCommand =
  | { type: "set_personal" }
  | { type: "split_all" }
  | { type: "split_between"; participantIds: string[]; participantNames: string[] }
  | { type: "set_payer"; payerId: string; payerName: string }
  | { type: "attach_receipt"; receiptId: string; receiptLabel: string }
  | { type: "exclude" }
  | { type: "include" };

export type ParsedTransactionCommand =
  | {
      ok: true;
      normalized: string;
      command: TransactionCommand;
      preview: string;
    }
  | {
      ok: false;
      normalized: string;
      error: string;
    };

const HELP_TEXT =
  "Try: 'this was only me', 'shared by everyone', 'split between Alex, Sam', 'Rohan paid this in cash', 'attach receipt ZX-ALPHA', 'exclude this', or 'include this'.";

function normalize(input: string): string {
  return input.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function toLookupMap(members: CommandMember[]): Map<string, CommandMember> {
  const lookup = new Map<string, CommandMember>();
  for (const member of members) {
    lookup.set(member.name.toLowerCase(), member);
  }
  return lookup;
}

function resolveMemberToken(
  token: string,
  members: CommandMember[],
  activeMemberId: string | null,
): CommandMember | null {
  const normalizedToken = token.trim().toLowerCase();
  if (!normalizedToken) {
    return null;
  }

  if (normalizedToken === "me" || normalizedToken === "myself") {
    if (!activeMemberId) {
      return null;
    }
    return members.find((member) => member.id === activeMemberId) ?? null;
  }

  const exact = members.find((member) => member.name.toLowerCase() === normalizedToken);
  if (exact) {
    return exact;
  }

  const prefixMatches = members.filter((member) =>
    member.name.toLowerCase().startsWith(normalizedToken),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  const includesMatches = members.filter((member) =>
    member.name.toLowerCase().includes(normalizedToken),
  );
  if (includesMatches.length === 1) {
    return includesMatches[0];
  }

  const firstNameMatches = members.filter((member) => {
    const [firstName] = member.name.toLowerCase().split(" ");
    return firstName === normalizedToken;
  });
  if (firstNameMatches.length === 1) {
    return firstNameMatches[0];
  }

  return null;
}

function parseNameList(raw: string): string[] {
  return raw
    .replaceAll(/\band\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function resolveReceiptToken(
  token: string,
  receipts: CommandReceipt[],
):
  | { ok: true; receipt: CommandReceipt }
  | { ok: false; error: string } {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    return { ok: false, error: "Receipt reference is required." };
  }

  const exactIdMatch = receipts.find((receipt) => receipt.id.toLowerCase() === normalizedToken);
  if (exactIdMatch) {
    return { ok: true, receipt: exactIdMatch };
  }

  const matches = receipts.filter((receipt) => {
    const merchant = receipt.merchant.toLowerCase();
    const sourceName = receipt.sourceName.toLowerCase();
    const bookingIds = receipt.bookingIds.map((bookingId) => bookingId.toLowerCase());
    return (
      merchant.includes(normalizedToken) ||
      sourceName.includes(normalizedToken) ||
      bookingIds.some((bookingId) => bookingId.includes(normalizedToken))
    );
  });

  if (matches.length === 0) {
    return {
      ok: false,
      error: `No receipt matched '${token}'. Try merchant, filename, or booking ID.`,
    };
  }

  if (matches.length > 1) {
    const options = matches
      .slice(0, 4)
      .map((receipt) => `${receipt.merchant} (${receipt.sourceName})`)
      .join("; ");
    return {
      ok: false,
      error: `Receipt '${token}' is ambiguous. Be more specific: ${options}.`,
    };
  }

  return { ok: true, receipt: matches[0] };
}

export function parseTransactionCommand(
  input: string,
  members: CommandMember[],
  activeMemberId: string | null,
  receipts: CommandReceipt[] = [],
): ParsedTransactionCommand {
  const normalized = normalize(input);
  if (!normalized) {
    return { ok: false, normalized, error: HELP_TEXT };
  }

  if (/(^|\b)(exclude this|exclude)(\b|$)/.test(normalized)) {
    return {
      ok: true,
      normalized,
      command: { type: "exclude" },
      preview: "Exclude this transaction from settlement.",
    };
  }

  if (/(^|\b)(include this|include)(\b|$)/.test(normalized)) {
    return {
      ok: true,
      normalized,
      command: { type: "include" },
      preview: "Include this transaction in settlement.",
    };
  }

  if (/(^|\b)(only me|this was only me|personal)(\b|$)/.test(normalized)) {
    return {
      ok: true,
      normalized,
      command: { type: "set_personal" },
      preview: "Mark as personal and keep only the payer in the split.",
    };
  }

  if (
    /split(?: this)? between (everyone|all of us|all)\b/.test(normalized) ||
    /(shared by everyone|for all of us|for everyone)\b/.test(normalized)
  ) {
    return {
      ok: true,
      normalized,
      command: { type: "split_all" },
      preview: "Split equally between everyone.",
    };
  }

  const splitBetweenMatch = normalized.match(/^split(?: this)? between (.+)$/);
  if (splitBetweenMatch) {
    const rawNames = parseNameList(splitBetweenMatch[1]);
    if (rawNames.length === 0) {
      return { ok: false, normalized, error: HELP_TEXT };
    }

    const resolvedMembers: CommandMember[] = [];
    for (const name of rawNames) {
      const resolved = resolveMemberToken(name, members, activeMemberId);
      if (!resolved) {
        return {
          ok: false,
          normalized,
          error: `Could not find '${name}'. ${HELP_TEXT}`,
        };
      }
      if (!resolvedMembers.some((member) => member.id === resolved.id)) {
        resolvedMembers.push(resolved);
      }
    }

    return {
      ok: true,
      normalized,
      command: {
        type: "split_between",
        participantIds: resolvedMembers.map((member) => member.id),
        participantNames: resolvedMembers.map((member) => member.name),
      },
      preview: `Split equally between ${resolvedMembers.map((member) => member.name).join(", ")}.`,
    };
  }

  const payerMatch = normalized.match(/^(.+?) paid(?: this)?(?: in cash)?$/);
  if (payerMatch) {
    const token = payerMatch[1].trim();
    const resolved = resolveMemberToken(token, members, activeMemberId);
    if (!resolved) {
      return {
        ok: false,
        normalized,
        error: `Could not find '${token}'. ${HELP_TEXT}`,
      };
    }

    return {
      ok: true,
      normalized,
      command: {
        type: "set_payer",
        payerId: resolved.id,
        payerName: resolved.name,
      },
      preview: `${resolved.name} becomes the payer for this expense.`,
    };
  }

  const attachReceiptMatch = normalized.match(/^(?:match this to|attach) receipt (.+)$/);
  if (attachReceiptMatch) {
    const receiptLookup = resolveReceiptToken(attachReceiptMatch[1], receipts);
    if (!receiptLookup.ok) {
      return {
        ok: false,
        normalized,
        error: `${receiptLookup.error} ${HELP_TEXT}`,
      };
    }

    const receipt = receiptLookup.receipt;
    return {
      ok: true,
      normalized,
      command: {
        type: "attach_receipt",
        receiptId: receipt.id,
        receiptLabel: `${receipt.merchant} (${receipt.sourceName})`,
      },
      preview: `Attach receipt ${receipt.merchant} (${receipt.sourceName}).`,
    };
  }

  const lookup = toLookupMap(members);
  const memberNames = [...lookup.values()].map((member) => member.name).join(", ");
  return {
    ok: false,
    normalized,
    error: `${HELP_TEXT} Members: ${memberNames}.`,
  };
}
