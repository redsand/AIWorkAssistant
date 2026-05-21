/**
 * @module kanban-dep-utils
 * Pure utility functions for kanban dependency arrow rendering.
 * Extracted for testability — used by kanban.js.
 */

/* global window */

(function (root) {
  "use strict";

  var KanbanDepUtils = {};

  /**
   * Compute the center point of a card element relative to the board.
   * @param {HTMLElement} el - The card element.
   * @param {DOMRect} boardRect - Bounding rect of the board container.
   * @returns {{ x: number, y: number }}
   */
  KanbanDepUtils.getCardCenter = function (el, boardRect) {
    var r = el.getBoundingClientRect();
    return {
      x: r.left - boardRect.left + r.width / 2,
      y: r.top - boardRect.top + r.height / 2,
    };
  };

  /**
   * Build an SVG cubic-bezier path string from one point to another.
   * @param {{ x: number, y: number }} from
   * @param {{ x: number, y: number }} to
   * @returns {string} SVG path "d" attribute value.
   */
  KanbanDepUtils.buildEdgePath = function (from, to) {
    var H = (to.x - from.x) / 2;
    return "M " + from.x + "," + from.y +
      " C " + (from.x + H) + "," + from.y +
      " " + (from.x + H) + "," + to.y +
      " " + to.x + "," + to.y;
  };

  /**
   * Safely find an element by its data-key attribute.
   * Avoids querySelector string interpolation with unsanitized keys.
   * @param {HTMLElement} parent - The parent element to search within.
   * @param {string} key - The data-key value to match.
   * @returns {HTMLElement|null}
   */
  KanbanDepUtils.safeFindByDataKey = function (parent, key) {
    var items = parent.querySelectorAll("[data-key]");
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute("data-key") === key) {
        return items[i];
      }
    }
    return null;
  };

  /* istanbul ignore else */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = KanbanDepUtils;
  } else {
    root.KanbanDepUtils = KanbanDepUtils;
  }
})(typeof window !== "undefined" ? window : this);
