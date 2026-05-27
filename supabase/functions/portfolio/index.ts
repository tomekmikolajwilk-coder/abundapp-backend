import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const MOCK_PORTFOLIO = {
  total_value: 127430.50,
  currency: "PLN",
  assets: [
    {
      id: "BTC",
      name: "Bitcoin",
      amount: 0.25,
      value: 62100.00,
      percentage: 48.7,
    },
    {
      id: "AAPL",
      name: "Apple Inc.",
      amount: 10,
      value: 38200.00,
      percentage: 30.0,
    },
    {
      id: "XAU",
      name: "Złoto",
      amount: 2,
      value: 24130.50,
      percentage: 18.9,
    },
    {
      id: "EUR",
      name: "Euro",
      amount: 500,
      value: 3000.00,
      percentage: 2.4,
    },
  ],
};

serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const currency = url.searchParams.get("currency") ?? "PLN";

  const response = {
    ...MOCK_PORTFOLIO,
    currency,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
