import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";

describe("Nodemailer v9 runtime compatibility", () => {
  it("constructs the SMTP transport options used by email delivery", () => {
    const options = {
      host: "127.0.0.1",
      port: 2525,
      secure: false,
      requireTLS: true,
      connectionTimeout: 1_000,
      greetingTimeout: 1_000,
      socketTimeout: 1_000,
      auth: { user: "mailer", pass: "app-password" },
    };
    const transport = nodemailer.createTransport(options);

    try {
      expect(typeof transport.sendMail).toBe("function");
      expect((transport as typeof transport & { options: typeof options }).options).toMatchObject(
        options,
      );
    } finally {
      transport.close();
    }
  });
});
