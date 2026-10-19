
export async function POST(req: Request) {
  const { message } = await req.json();

  if (typeof message !== "string" || !message.trim()) {
    return Response.json(
      { error: "Message is required" },
      { status: 400 }
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    return Response.json(
      { error: "OpenRouter request failed" },
      { status: response.status }
    );
  }

  const data = await response.json();

  return Response.json({
    answer: data.choices[0]?.message?.content ?? "",
  });
}
