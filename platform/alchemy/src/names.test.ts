import { describe, expect, test } from "bun:test"

import { ACTOR_CLASS, ACTORS_BINDING, THREAD_CLASS, THREADS_BINDING, tardigradeClassNames } from "./names"

describe("tardigradeClassNames", () => {
  test("defaults to the classes the host exports", () => {
    expect(tardigradeClassNames()).toEqual({
      actorClassName: ACTOR_CLASS,
      threadClassName: THREAD_CLASS,
    })
  })

  test("accepts re-exported class names", () => {
    expect(tardigradeClassNames({ actorClassName: "SupervisorDO", threadClassName: "SessionDO" })).toEqual({
      actorClassName: "SupervisorDO",
      threadClassName: "SessionDO",
    })
  })

  test("names the namespaces the host reads", () => {
    expect(ACTORS_BINDING).toBe("ACTORS")
    expect(THREADS_BINDING).toBe("THREADS")
  })
})
