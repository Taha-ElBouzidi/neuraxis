# Five things to try in ten minutes

Each one is a sentence you type to your assistant after Neuraxis is installed. Start a new conversation for each,
so you see the memory work across conversations.

1. **Tell it something to keep.** "Remember that I prefer short answers, and that my main project is <name>."
   Then, in a new conversation: "How do I like my answers?" It should answer from the memory and name the file.

2. **Correct it.** "That is wrong: my main project is now <other name>." Then ask again in a new conversation. The
   old fact is replaced, not kept beside the new one.

3. **Use a ready method.** "Write a one-page document about <topic>, using your method for documents." It follows
   the kit method `reference_how_to_write_a_document` and tells you so.

4. **See what it knows.** "What do you know about me?" It lists the memories it found. Then: "Open the map of my
   memory." It runs `node tools/dashboard.mjs --open` and your memories appear grouped by topic.

5. **Make it forget.** "Forget that I prefer short answers." Then check in a new conversation that it no longer
   knows it.

With the full system (Claude Code on Windows), also try: "What decisions have you taken for me this week?" and open
your review page to keep or reverse one.
