import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

describe("Tabs", () => {
  it("marks the active tab, shows its panel, and arrows + Enter switch", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="card">
        <TabsList aria-label="데이터셋">
          <TabsTrigger value="card">데이터 카드</TabsTrigger>
          <TabsTrigger value="versions" count={3}>
            버전
          </TabsTrigger>
        </TabsList>
        <TabsContent value="card">카드 내용</TabsContent>
        <TabsContent value="versions">버전 내용</TabsContent>
      </Tabs>,
    );
    const card = screen.getByRole("tab", { name: "데이터 카드" });
    expect(card).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("카드 내용");
    card.focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(screen.getByRole("tab", { name: "버전 3" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("버전 내용");
  });
});
