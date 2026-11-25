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
    expect(box.innerHTML).toBe("<p>Try <strong>The Complete Snowboard</strong> today</p>");
  });

  it("turns a run of bullet lines into one list between paragraphs, dropping the line breaks around it", () => {
    const box = render("Here are a few options:\n\n- **A** has five colours.\n- B is premium.\n\nWant more?");
    expect(box.innerHTML).toBe(
      "<p>Here are a few options:</p><ul><li><strong>A</strong> has five colours.</li><li>B is premium.</li></ul><p>Want more?</p>",
    );
  });

  it("keeps one list across a blank line between bullets, and accepts * and • bullets", () => {
    expect(render("* a\n\n• b").innerHTML).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("keeps plain line breaks and an unclosed ** (mid-stream) as typed", () => {
    expect(render("one\ntwo **bo").innerHTML).toBe("<p>one\ntwo **bo</p>");
  });

  it("never parses HTML from the model (D36)", () => {
    const box = render('**<img src=x onerror="alert(1)">**\n- <script>x</script>');
    expect(box.querySelector("img, script")).toBeNull();
    expect(box.textContent).toBe('<img src=x onerror="alert(1)"><script>x</script>');
  });

  it("shows the whole text again on each call (streaming), also when the text was replaced", () => {
    const box = document.createElement("div");
    renderRich(box, "- a");
    renderRich(box, "- a\n- b");
    expect(box.querySelectorAll("li")).toHaveLength(2);
    renderRich(box, "Now just text");
    expect(box.innerHTML).toBe("<p>Now just text</p>");
  });
});

describe("renderRich paragraphs", () => {
  it("puts text separated by a blank line in separate <p> elements; one line break stays inside its paragraph", () => {
    expect(render("One.\n\nTwo.\n\nThree.").innerHTML).toBe("<p>One.</p><p>Two.</p><p>Three.</p>");
    expect(render("One.\nStill one.").innerHTML).toBe("<p>One.\nStill one.</p>");
    expect(render("Intro.\n\nMore **bold**.").innerHTML).toBe("<p>Intro.</p><p>More <strong>bold</strong>.</p>");
  });
});


describe("renderRich while streaming", () => {
  const stream = (box: HTMLElement, text: string, fade = true) => renderRich(box, text, fade);

  it("keeps the paragraphs that are done (same nodes), and only the last one changes", () => {
    const box = document.createElement("div");
    stream(box, "First paragraph.\n\nSec");
    const [first, second] = Array.from(box.children);
    stream(box, "First paragraph.\n\nSecond paragraph.");
    expect(box.children[0]).toBe(first);
    expect(box.children[1]).toBe(second); // grown in place
    expect(box.textContent).toBe("First paragraph.Second paragraph.");
    stream(box, "First paragraph.\n\nSecond paragraph.\n\nThird");
    expect(Array.from(box.children).slice(0, 2)).toEqual([first, second]);
    expect(box.children).toHaveLength(3);
  });

  it("marks only the paragraphs that are new in this call with .nw, and never touches history", () => {
    const box = document.createElement("div");
    stream(box, "One");
    expect(box.children[0].classList.contains("nw")).toBe(true);
    stream(box, "One\n\nTwo");
    expect(box.children[1].classList.contains("nw")).toBe(true);
    const plain = document.createElement("div");
    renderRich(plain, "One\n\nTwo");
    expect(plain.querySelector(".nw")).toBeNull();
  });

  it("turns a paragraph into a list in the same place when the text changes shape", () => {
    const box = document.createElement("div");
    stream(box, "Intro\n\n- a");
    stream(box, "Intro\n\n- a\n- b");
    expect(box.innerHTML).toBe('<p>Intro</p><ul class="nw"><li>a</li><li>b</li></ul>'.replace('<p>Intro</p>', '<p class="nw">Intro</p>'));
  });
});
