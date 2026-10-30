import { describe, expect, it, vi } from "vitest";

import { createBrevoTransport, parseSender } from "../src/services/mail.service.js";

describe("parseSender", () => {
  it("sépare le nom et l'adresse", () => {
    expect(parseSender('"Support Tickets" <noreply@exemple.com>')).toEqual({
      name: "Support Tickets",
      email: "noreply@exemple.com",
    });
    expect(parseSender("Support Tickets <noreply@exemple.com>")).toEqual({
      name: "Support Tickets",
      email: "noreply@exemple.com",
    });
  });

  it("accepte une adresse seule", () => {
    expect(parseSender("noreply@exemple.com")).toEqual({ email: "noreply@exemple.com" });
    expect(parseSender("<noreply@exemple.com>")).toEqual({ email: "noreply@exemple.com" });
  });
});

describe("createBrevoTransport", () => {
  const mail = { from: "Support <noreply@exemple.com>", to: "agent@exemple.com", subject: "Sujet", text: "Bonjour" };

  it("appelle l'API Brevo avec la clé en en-tête et le bon corps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "abc" }), { status: 201 }));

    await createBrevoTransport("cle-de-test", fetchMock as unknown as typeof fetch).sendMail(mail);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe("cle-de-test");
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: "Support", email: "noreply@exemple.com" },
      to: [{ email: "agent@exemple.com" }],
      subject: "Sujet",
      textContent: "Bonjour",
    });
  });

  it("lève une erreur lisible, sans exposer la clé, quand Brevo refuse", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "Sender is not valid" }), { status: 400 }));

    const send = createBrevoTransport("cle-secrete", fetchMock as unknown as typeof fetch).sendMail(mail);

    await expect(send).rejects.toThrow("Brevo a refusé l'envoi (400) : Sender is not valid");
    await expect(send).rejects.not.toThrow(/cle-secrete/);
  });
});
