import { Alert, Button, Center, Code, CopyButton, Group, Modal, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

import { useHeldOpen } from "./use-held-open.ts";

export interface RevealedLink {
  url: string;
  /** Who or what the link is for, e.g. "Invite for Grace (employee)". */
  label: string;
  expires: string;
}

/**
 * Shows a freshly minted one-time link. The token is only stored hashed, so
 * this is the one and only time it can be seen — the copy says so.
 *
 * Offers the three ways a link actually travels: a QR code to scan from the
 * admin's screen, the system share sheet (Messages, email), and copy.
 */
export function LinkReveal({ link, onClose }: { link: RevealedLink | null; onClose: () => void }) {
  const [canShare, setCanShare] = useState(false);
  // On a phone the dialog takes the whole screen, so the QR code, the link and
  // the Done button all fit without a scroll trap behind a notification.
  const narrow = useMediaQuery("(max-width: 36em)");
  const opened = link != null;
  // Closing clears the link; the dialog would otherwise fade out empty.
  const shown = useHeldOpen(opened, link);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  return (
    <Modal opened={opened} onClose={onClose} title="One-time link" centered size="md" fullScreen={narrow}>
      {shown && (
        <Stack gap="md">
          <Text fw={500}>{shown.label}</Text>
          <Center>
            <QRCodeSVG value={shown.url} size={220} marginSize={2} aria-label="QR code of the link" />
          </Center>
          <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {shown.url}
          </Code>
          <Group grow>
            <CopyButton value={shown.url}>
              {({ copied, copy }) => (
                <Button variant={copied ? "filled" : "light"} color={copied ? "green" : undefined} onClick={copy}>
                  {copied ? "Copied" : "Copy link"}
                </Button>
              )}
            </CopyButton>
            {canShare && (
              <Button
                variant="light"
                onClick={() => {
                  navigator.share({ title: shown.label, url: shown.url }).catch(() => {});
                }}
              >
                Share…
              </Button>
            )}
          </Group>
          <Alert color="blue">
            Works once, until {shown.expires}. This is the only time it's shown — if it's lost, revoke it and make
            a new one.
          </Alert>
          <Button onClick={onClose}>Done</Button>
        </Stack>
      )}
    </Modal>
  );
}
