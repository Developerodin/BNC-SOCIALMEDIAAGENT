// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderRich } from "../../widget/src/panel/rich";

const render = (text: string) => {
  const box = document.createElement("div");
  renderRich(box, text);
  return box;
};

describe("renderRich", () => {
  it("turns **x** into <strong> and keeps the rest as text", () => {
    const box = render("Try **The Complete Snowboard** today");
    expect(box.innerHTML).toBe("Try <strong>The Complete Snowboard</strong> today");
  });

  it("turns a run of bullet lines into one list, dropping the line breaks around it", () => {
    const box = render("Here are a few options:\n\n- **A** has five colours.\n- B is premium.\n\nWant more?");
    expect(box.innerHTML).toBe(
      "Here are a few options:<ul><li><strong>A</strong> has five colours.</li><li>B is premium.</li></ul>Want more?",
    );
  });

  it("keeps one list across a blank line between bullets, and accepts * and • bullets", () => {
    expect(render("* a\n\n• b").innerHTML).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("keeps plain line breaks and an unclosed ** (mid-stream) as typed", () => {
    expect(render("one\ntwo **bo").innerHTML).toBe("one\ntwo **bo");
  });

  it("never parses HTML from the model (D36)", () => {
    const box = render('**<img src=x onerror="alert(1)">**\n- <script>x</script>');
    expect(box.querySelector("img, script")).toBeNull();
    expect(box.textContent).toBe('<img src=x onerror="alert(1)"><script>x</script>');
  });

  it("rebuilds from scratch on each call (streaming)", () => {
    const box = document.createElement("div");
    renderRich(box, "- a");
    renderRich(box, "- a\n- b");
    expect(box.querySelectorAll("li")).toHaveLength(2);
  });
});
