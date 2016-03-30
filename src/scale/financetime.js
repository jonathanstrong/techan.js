'use strict';

/*
 Finance time scale which is not necessarily continuous, is required to be plot continuous. Finance scale
 generally contains data points on days where a market is open but no points when closed, such as weekday
 and weekends respectively. When plot, is done so without weekend gaps.
 */
module.exports = function(d3_scale_linear, d3_time, d3_bisect, techan_util_rebindCallback, scale_widen, zoomable) {  // Injected dependencies
  function financetime(tickMethods, genericFormat, index, domain, padding, outerPadding, zoomLimit, closestTicks) {
    var dateIndexMap,
        tickState = { tickFormat: tickMethods.daily[tickMethods.daily.length-1][2] },
        band = 3;

    index = index || d3_scale_linear();
    domain = domain || [new Date(0), new Date(1)];
    padding = padding === undefined ? 0.2 : padding;
    outerPadding = outerPadding === undefined ? 0.65 : outerPadding;
    zoomLimit = zoomLimit || index.domain();
    closestTicks = closestTicks || false;

    /**
     * Scales the value to domain. If the value is not within the domain, will currently brutally round the data:
     * - If before min domain, will round to 1 index value before min domain
     * - If after max domain, will round to 1 index value after min domain
     * - If within domain, but not mapped to domain value, uses d3.bisect to find nearest domain index
     *
     * This logic was not required until the domain was being updated and scales re-rendered and this line
     * https://github.com/mbostock/d3/blob/abbe1c75c16c3e9cb08b1d0872f4a19890d3bb58/src/svg/axis.js#L107 was causing error.
     * New scale generated ticks that old scale did not have, causing error during transform. To avoid error this logic
     * was added.
     *
     * @param x The value to scale
     * @param offset Apply an index offset to the mapped x (date) parameter
     * @returns {*}
     */
    function scale(x, offset) {
      var mappedIndex = dateIndexMap[+x];
      offset = offset || 0;

      // Make sure the value has been mapped, if not, determine if it's just before, round in, or just after domain
      if(mappedIndex === undefined) {
        if(domain[0] > x) mappedIndex = -1; // Less than min, round just out of domain
        else mappedIndex = d3_bisect(domain, x); // else let bisect determine where in or just after than domain it is
      }

      return index(mappedIndex + offset);
    }

    /**
     * Invert the passed range coordinate to the corresponding domain. Returns null if no valid domain available.
     *
     * @param y
     * @returns {null} If the range value cannot be mapped. eg, if range value is outside of the mapped domain
     */
    scale.invert = function(y) {
      var d = domain[scale.invertToIndex(y)];
      return d ? d : null;
    };

    /**
     * Inverts the coordinate to the corresponding domain. <b>NOTE: </b> May return values outside of the domain such
     * as negative indexes, or an index greater than what is available in the domain.
     *
     * @param y
     * @returns {number} A number representing the index in the domain the range value has been inverted to. May return
     * values outside of the domain such as negatives or value greater than domain().length-1
     */
    scale.invertToIndex = function(y) {
      return Math.round(index.invert(y));
    };

    /**
     * As the underlying structure relies on a full array, ensure the full domain is passed here,
     * not just min and max values.
     *
     * @param _ The full domain array
     * @returns {*}
     */
    scale.domain = function(_) {
      if (!arguments.length) {
        var visible = index.domain();

        if(visible[0] < 0 && visible[visible.length-1] < 0) return []; // if it's all negative return empty, nothing is visible

        visible = [
          Math.max(Math.ceil(visible[0]), 0), // If min is fraction, it is partially out of view, but still partially visible, round up (ceil)
          Math.min(Math.floor(visible[visible.length-1]), domain.length-1) // If max is fraction, is partially out of view, but still partially visible, round down (floor)
        ];
        return domain.slice(visible[0], visible[visible.length-1]+1); // Grab visible domain, inclusive
      }

      domain = _;
      return applyDomain();
    };

    function zoomed() {
      band = rangeBand(index, domain, padding);
      return scale;
    }

    function domainMap() {
      dateIndexMap = lookupIndex(domain);
    }

    function applyDomain() {
      domainMap();
      index.domain([0, domain.length-1]);
      zoomed();
      // Apply outerPadding and widen the outer edges by pulling the domain in to ensure start and end bands are fully visible
      index.domain(index.range().map(scale_widen(outerPadding, band)).map(index.invert));
      zoomLimit = index.domain(); // Capture the zoom limit after the domain has been applied
      return zoomed();
    }

    scale.copy = function() {
      return financetime(tickMethods, genericFormat, index.copy(), domain, padding, outerPadding, zoomLimit, closestTicks);
    };

    /**
     * Equivalent to d3's ordinal.rangeBand(). It could not be named rangeBand as d3 uses the method
     * to determine how axis ticks should be rendered. This scale is a hybrid ordinal and linear scale,
     * such that scale(x) returns y at center of the band as does d3.scale.linear()(x) does, whereas
     * d3.scale.ordinal()(x) returns y at the beginning of the band. When rendering svg axis, d3
     * compensates for this checking if rangeBand is defined and compensates as such.
     * @returns {number}
     */
    scale.band = function() {
      return band;
    };

    scale.outerPadding = function(_) {
      if(!arguments.length) return outerPadding;
      outerPadding = _;
      return applyDomain();
    };

    scale.padding = function(_) {
      if(!arguments.length) return padding;
      padding = _;
      return applyDomain();
    };

    scale.zoomable = function() {
      return zoomable(index, zoomed, zoomLimit);
    };

    /*
     * Ticks based heavily on d3 implementation. Attempted to implement this using composition with d3.time.scale,
     * but in the end there were sufficient differences to 'roll my own'.
     * - Different base tick steps: millis not required (yet!)
     * - State based tick formatting given the non continuous, even steps of ticks
     * - Supporting daily and intraday continuous (no gaps) plotting
     * https://github.com/mbostock/d3/blob/e03b6454294e1c0bbe3125f787df56c468658d4e/src/time/scale.js#L67
     */
    /**
     * Generates ticks as continuous as possible against the underlying domain. Where continuous time ticks
     * fall on where there is no matching domain (such as weekend or holiday day), it will be replaced with
     * the nearest domain datum ahead of the tick to keep close to continuous.
     * @param interval
     * @param steps
     * @returns {*}
     */
    scale.ticks = function(interval, steps) {
      var visibleDomain = scale.domain(),
          indexDomain = index.domain();

      if(!visibleDomain.length) return []; // Nothing is visible, no ticks to show

      var method = interval === undefined ? tickMethod(visibleDomain, indexDomain, 10) :
                    typeof interval === 'number' ? tickMethod(visibleDomain, indexDomain, interval) : null;

      tickState.tickFormat = method ? method[2] : tickMethod(visibleDomain, indexDomain, 10)[2];

      if(method) {
        interval = method[0];
        steps = method[1];
      }

      var intervalRange = interval.range(visibleDomain[0], +visibleDomain[visibleDomain.length-1]+1, steps);

      return intervalRange                                // Interval, possibly contains values not in domain
        .map(domainTicks(visibleDomain, closestTicks))    // Line up interval ticks with domain, possibly adding duplicates
        .reduce(sequentialDuplicates, []);                // Filter out duplicates, produce new 'reduced' array
    };
    function tickMethod(visibleDomain, indexDomain, count) {
      if(visibleDomain.length == 1) return genericFormat; // If we only have 1 to display, show the generic tick method

      var visibleDomainIncrement = visibleDomain[1] - visibleDomain[0],
        gap = visibleDomainIncrement / dailyStep,
        intraday_data = gap < 1, // Determine whether we're showing daily or intraday data
        visibleDomainExtent = visibleDomain[visibleDomain.length-1] - visibleDomain[0],
        days_visible = visibleDomainExtent/dailyStep,
        intraday = (intraday_data & days_visible < 6),
        methods = intraday  ? tickMethods.intraday : tickMethods.daily,
        tickSteps = intraday ? intradayTickSteps : dailyTickSteps,
        k = Math.min(Math.round(countK(visibleDomain, indexDomain)*count), count),
        target = visibleDomainExtent/k, // Adjust the target based on proportion of domain that is visible
        i = d3_bisect(tickSteps, target);
        prev_date = undefined;

      if ( i == methods.length ) { // return the largest tick method
        return methods[i-1];
      }
      else {
        if ( i ) {
          // search index j (i +/- 1) for
          // tickSteps[j]/target ratio closest to 1
          var diffs = [];
          d3.range(methods.length).forEach(function(j){
              diffs.push([j, Math.abs(1-tickSteps[j]/target)]);
          });
          diffs.sort(function(a, b){
              return a[1]-b[1];
          });
          return methods[diffs[0][0]];
        }
        else {
          return methods[0];
        }
      }
    }

    /**
     * By default `ticks()` will generate tick values greater than the nearest domain interval value, which may not be
     * best value, particularly for irregular intraday domains. Setting this to true will cause tick generation to choose
     * values closest to the corresponding domain value for the calculated interval.
     * @param _ Optional `boolean` value. If argument is passed, sets the value and returns this instance, if no argument, returns the current value
     */
    scale.closestTicks = function(_) {
      if(!arguments.length) return closestTicks;
      closestTicks = _;
      return scale;
    };

    /**
     * NOTE: The type of tick format returned is dependant on ticks that were generated. To obtain the correct
     * format for ticks, ensure ticks function is called first, otherwise a default tickFormat will be returned
     * which may not be the optimal representation of the current domain state.
     * @returns {Function}
     */
    scale.tickFormat = function() {
      return function(date) {
        return tickState.tickFormat(date);
      };
    };

    techan_util_rebindCallback(scale, index, zoomed, 'range');

    domainMap();
    return zoomed();
  }

  function rangeBand(linear, domain, padding) {
    return (Math.abs(linear(domain.length-1) - linear(0))/Math.max(1, domain.length-1))*(1-padding);
  }

  /**
   * Calculates the proportion of domain that is visible. Used to reduce the overall count by this factor
   * @param visibleDomain
   * @param indexDomain
   * @returns {number}
   */
  function countK(visibleDomain, indexDomain) {
    return visibleDomain.length/(indexDomain[indexDomain.length-1]-indexDomain[0]);
  }

  function lookupIndex(array) {
    var lookup = {};
    array.forEach(function(d, i) { lookup[+d] = i; });
    return lookup;
  }

  function domainTicks(visibleDomain, closest) {
    var visibleDomainLookup = lookupIndex(visibleDomain); // Quickly lookup index of the domain

    return function(d) {
      var value = visibleDomainLookup[+d];
      if (value !== undefined) return visibleDomain[value];
      return visibleDomain[d3_bisect(visibleDomain, d)];
    };
  }

  function sequentialDuplicates(previous, current) {
    if(previous.length === 0 || previous[previous.length-1] !== current) previous.push(current);
    return previous;
  }


  var dailyStep = 864e5,
      dailyTickSteps = [
        dailyStep,  // 1-day
        6048e5,     // 1-week
        2592e6,     // 1-month
        7776e6,     // 3-month
        31536e6     // 1-year
      ],
      intradayTickSteps = [
        1e3,    // 1-second
        5e3,    // 5-second
        15e3,   // 15-second
        3e4,    // 30-second
        6e4,    // 1-minute
        3e5,    // 5-minute
        9e5,    // 15-minute
        18e5,   // 30-minute
        1*36e5, // 1-hour
        2*36e5, // 2-hour
        3*36e5, // 3-hour
        4*36e5, // 4-hour
        6*36e5, // 6-hour
        12*36e5,// 12-hour
        864e5   // 1-day
      ];

  var prev_date = undefined;
  var dayFormat = d3_time.format('%b %e'),
      yearFormat = d3_time.format.multi([
        ['%b', function(d) { return d.getMonth(); }],
        ['%Y', function() { return true; }]
      ]),
      intradayFormat = d3_time.format.multi([
        ["%b %e", function(d) {
           if (prev_date !== undefined && d.getDate() != prev_date.getDate()) {
               prev_date = d;
               return true;
           }
           prev_date = d;
           return false;
        }],
        ["%H:%M", function(d) { 
            prev_date = d; 
            if ( d.getHours() >= 16 ) {
                //console.log(d);
                return false;
            }
            return true; }],
        ['', function(d){ prev_date = d; return true; }],
        //["%H:%M", function (d) { prev_date = d; return true; }]
      ]),
      genericFormat = [d3_time.second, 1, d3_time.format.multi([
          [":%S", function(d) { return d.getSeconds(); }],
          ["%I:%M", function(d) { return d.getMinutes(); }],
          ["%I %p", function(d) { return d.getHours(); }],
          ['%b %e', function() { return true; }]
        ])
      ];

  var dayFormatUtc = d3_time.format.utc('%b %e'),
      yearFormatUtc = d3_time.format.utc.multi([
        ['%b %Y', function(d) { return d.getUTCMonth(); }],
        ['%Y', function() { return true; }]
      ]),
      intradayFormatUtc = d3_time.format.utc.multi([
        [":%S", function(d) { return d.getUTCSeconds(); }],
        ["%I:%M", function(d) { return d.getUTCMinutes(); }],
        ["%I %p", function () { return true; }]
      ]),
      genericFormatUtc = [d3_time.second, 1, d3_time.format.utc.multi([
          [":%S", function(d) { return d.getUTCSeconds(); }],
          ["%I:%M", function(d) { return d.getUTCMinutes(); }],
          ["%I %p", function(d) { return d.getUTCHours(); }],
          ['%b %e', function() { return true; }]
        ])
      ];

  var dailyTickMethod = [
      [d3_time.day, 1, dayFormat],
      [d3_time.monday, 1, dayFormat],
      [d3_time.month, 1, yearFormat],
      [d3_time.month, 3, yearFormat],
      [d3_time.year, 1, yearFormat]
    ],
    intradayTickMethod = [
      [d3_time.second, 1, intradayFormat],
      [d3_time.second, 5, intradayFormat],
      [d3_time.second, 15, intradayFormat],
      [d3_time.second, 30, intradayFormat],
      [d3_time.minute, 1, intradayFormat],
      [d3_time.minute, 5, intradayFormat],
      [d3_time.minute, 15, intradayFormat],
      [d3_time.minute, 30, intradayFormat],
      [d3_time.hour, 1, intradayFormat],
      [d3_time.hour, 2, intradayFormat],
      [d3_time.hour, 3, intradayFormat],
      [d3_time.hour, 4, intradayFormat],
      [d3_time.hour, 6, intradayFormat],
      [d3_time.hour, 12, intradayFormat],
      [d3_time.day, 1, dayFormat]
    ];

  var dailyTickMethodUtc = [
      [d3_time.day.utc, 1, dayFormatUtc],
      [d3_time.monday.utc, 1, dayFormatUtc],
      [d3_time.month.utc, 1, yearFormatUtc],
      [d3_time.month.utc, 3, yearFormatUtc],
      [d3_time.year.utc, 1, yearFormatUtc]
    ],
    intradayTickMethodUtc = [
      [d3_time.second.utc, 1, intradayFormatUtc],
      [d3_time.second.utc, 5, intradayFormatUtc],
      [d3_time.second.utc, 15, intradayFormatUtc],
      [d3_time.second.utc, 30, intradayFormatUtc],
      [d3_time.minute.utc, 1, intradayFormatUtc],
      [d3_time.minute.utc, 5, intradayFormatUtc],
      [d3_time.minute.utc, 15, intradayFormatUtc],
      [d3_time.minute.utc, 30, intradayFormatUtc],
      [d3_time.hour.utc, 1, intradayFormatUtc],
      [d3_time.hour.utc, 3, intradayFormatUtc],
      [d3_time.hour.utc, 6, intradayFormatUtc],
      [d3_time.hour.utc, 12, intradayFormatUtc],
      [d3_time.day.utc, 1, dayFormatUtc]
    ];

  function techan_scale_financetime() {
    return financetime({ daily: dailyTickMethod, intraday: intradayTickMethod }, genericFormat);
  }

  techan_scale_financetime.utc = function() {
    return financetime({ daily: dailyTickMethodUtc, intraday: intradayTickMethodUtc }, genericFormatUtc);
  };

  return techan_scale_financetime;
};
