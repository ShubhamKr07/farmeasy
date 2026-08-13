import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, ExternalLink } from "lucide-react";
import { usePostRecommend } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";

const EXAMPLE_QUESTIONS = [
  "why are my basil trays failing?",
  "what's my yield this week?",
  "best EC and pH for lettuce?",
  "why is my yield declining?",
  "recommend a nutrient supplier",
];

/**
 * Global "Ask Me" entry point — a persistent, always-visible question bar in
 * the TopBar (distinct from the ⌘K command palette, which navigates/acts
 * rather than answers questions). Submits to POST /api/recommend, which
 * grounds the answer in cached/live-searched vertical-farming knowledge plus
 * the farm's own operational data. The answer renders in a side sheet.
 */
export function AskMe() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const recommend = usePostRecommend();

  // Rotate the example placeholder while idle — pauses once the user has typed anything.
  useEffect(() => {
    if (question) return;
    const id = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % EXAMPLE_QUESTIONS.length);
    }, 3200);
    return () => clearInterval(id);
  }, [question]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setSubmittedQuestion(trimmed);
    recommend.mutate({ data: { question: trimmed } });
    setOpen(true);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSubmittedQuestion(null);
      recommend.reset();
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="relative flex-1 max-w-2xl">
        <Sparkles className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary" />
        <Input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onFocus={() => submittedQuestion && open === false && setOpen(true)}
          placeholder={`Ask me — e.g. ${EXAMPLE_QUESTIONS[placeholderIndex]}`}
          className="h-10 pl-9 pr-4 bg-muted/40 border-transparent focus-visible:bg-background transition-colors"
          aria-label="Ask a vertical-farming question"
          data-testid="input-ask-me"
        />
      </form>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Ask Me
            </SheetTitle>
            <SheetDescription>
              Ask anything about vertical farming — crop setpoints, troubleshooting, market data. Answers combine your
              own farm data with external knowledge.
            </SheetDescription>
          </SheetHeader>

          <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
            <Input
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a follow-up…"
              data-testid="input-ask-me-sheet"
            />
            <Button type="submit" disabled={recommend.isPending || !question.trim()} data-testid="button-ask-me-submit">
              {recommend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ask"}
            </Button>
          </form>

          <div className="mt-6 space-y-4">
            {recommend.isPending && (
              <p className="text-sm text-muted-foreground">Thinking…</p>
            )}

            {recommend.isError && (
              <p className="text-sm text-destructive">
                Something went wrong. Try again in a moment.
              </p>
            )}

            {recommend.isSuccess && submittedQuestion && (
              <div className="space-y-4" data-testid="ask-me-answer">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Q: {submittedQuestion}</p>
                  <p className="text-sm whitespace-pre-wrap">{recommend.data.answer}</p>
                </div>

                {recommend.data.sources.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Sources</p>
                    {recommend.data.sources.map((s) => (
                      <a
                        key={s.url}
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm hover:bg-muted/50 transition-colors"
                      >
                        <span className="truncate">{s.title || s.url}</span>
                        <span className="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                          <Badge variant="secondary" className="text-xs">
                            {Math.round(s.similarity * 100)}%
                          </Badge>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </span>
                      </a>
                    ))}
                  </div>
                )}

                {recommend.data.cache_hit && (
                  <p className="text-xs text-muted-foreground">Answered from cached knowledge.</p>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
